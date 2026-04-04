'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const { LinkM } = require('./linkm');

// ticks → fadeSpeed mapping (ticks are the native BlinkM unit, from BlinkMComm.pde)
// durTicks={1,18,72}, fadeSpeeds={100,25,5} for durations={3s,30s,120s}
const FADESPEED_FOR_TICKS = {
  1:  100,
  18: 25,
  72: 5,
};

const NULL_COLOR = { r: 55, g: 55, b: 55 }; // "unset" tile → burn as black

// ── State ──────────────────────────────────────────────────────────────────────
let win   = null;
const lm  = new LinkM();

lm.on('disconnect', err => {
  console.error('LinkM HID error:', err.message);
  win?.webContents.send('linkm:status', 'disconnected');
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── IPC handlers ───────────────────────────────────────────────────────────────

ipcMain.handle('linkm:connect', () => {
  if (lm.isConnected) {
    console.log('LinkM: already connected');
    return { ok: true };
  }
  const found = LinkM.devices();
  console.log(`LinkM: scanning — found ${found.length} device(s)`, found.map(d => d.path));
  if (!found.length) return { ok: false, error: 'No LinkM device found' };
  try {
    lm.connect();
    console.log('LinkM: connected');
    return { ok: true };
  } catch (e) {
    console.error('LinkM: open failed —', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('linkm:disconnect', () => {
  lm.disconnect();
  return { ok: true };
});

ipcMain.handle('linkm:status', () => ({
  connected:     lm.isConnected,
  devicePresent: LinkM.devices().length > 0,
}));

// Live color update during playback preview.
// Rate-limited and deduplicated — mirrors BlinkMComm.sendColor()'s guard.
let lastSentRgb  = null;
let lastSentTime = 0;
const MIN_SEND_MS = 30;   // ~33 Hz max

ipcMain.handle('linkm:sendColor', (_, r, g, b) => {
  const now = Date.now();
  if (lastSentRgb &&
      lastSentRgb[0] === r && lastSentRgb[1] === g && lastSentRgb[2] === b) {
    return { ok: true };
  }
  if (now - lastSentTime < MIN_SEND_MS) return { ok: true };
  try {
    lm.fadeToRGB(r, g, b);
    lastSentRgb  = [r, g, b];
    lastSentTime = Date.now();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Prepare BlinkM for preview (stop current script, set fade speed)
ipcMain.handle('linkm:preparePreview', (_, ticks) => {
  try {
    if (!lm.isConnected) return { ok: true };
    const fadeSpeed = FADESPEED_FOR_TICKS[ticks] ?? FADESPEED_FOR_TICKS[1];
    lm.stopScript();
    setTimeout(() => { try { lm.setFadeSpeed(fadeSpeed); } catch (_) {} }, 40);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Burn sequence to BlinkM EEPROM
ipcMain.handle('linkm:burn', async (_, colors, ticks, loop) => {
  try {
    const fadeSpeed = FADESPEED_FOR_TICKS[ticks] ?? FADESPEED_FOR_TICKS[1];
    const reps      = loop ? 0 : 1;

    for (let i = 0; i < colors.length; i++) {
      let { r, g, b } = colors[i];
      if (r === NULL_COLOR.r && g === NULL_COLOR.g && b === NULL_COLOR.b) {
        r = g = b = 0;
      }
      lm.writeScriptLine(i, ticks, r, g, b);
      win?.webContents.send('linkm:burnProgress', i, colors.length);
      await sleep(50);
    }

    lm.setScriptLength(0, colors.length, reps);
    await sleep(50);
    lm.setBootParams(fadeSpeed, reps);
    await sleep(50);
    lm.setFadeSpeed(fadeSpeed);
    await sleep(30);
    lm.playScript(0, reps, 0);
    await sleep(30);

    win?.webContents.send('linkm:burnProgress', colors.length, colors.length);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Returns the ticks key from FADESPEED_FOR_TICKS whose fade speed is
// closest to the given value (used when a setFadeSpeed line is read).
function closestTicksForFadeSpeed(fadeSpeed) {
  let bestTicks = 1, bestDiff = Infinity;
  for (const [ticks, fs] of Object.entries(FADESPEED_FOR_TICKS)) {
    const diff = Math.abs(fs - fadeSpeed);
    if (diff < bestDiff) { bestDiff = diff; bestTicks = Number(ticks); }
  }
  return bestTicks;
}

// Read sequence back from BlinkM EEPROM.
// Each script line: [ticks, cmd, arg1, arg2, arg3]
//   cmd 0x63 ('c') → fadeToRGB, args = r, g, b
//   cmd 0x66 ('f') → setFadeSpeed, arg1 = speed (used to infer duration)
// Returns { ok, colors[48], ticks } — ticks reflects the detected duration.
ipcMain.handle('linkm:download', async () => {
  try {
    lm.stopScript();
    await sleep(100);

    const colors = [];
    let detectedTicks     = null;   // from color-line ticks field
    let detectedFadeSpeed = null;   // from any setFadeSpeed line

    for (let i = 0; i < 48; i++) {
      const data      = lm.readScriptLine(i);
      const lineTicks = data[0];
      const cmd       = data[1];

      if (cmd === 0x63) {                              // 'c' fadeToRGB
        colors.push({ r: data[2], g: data[3], b: data[4] });
        if (detectedTicks === null) detectedTicks = lineTicks;
      } else if (cmd === 0x66) {                       // 'f' setFadeSpeed
        if (detectedFadeSpeed === null) detectedFadeSpeed = data[2];
        colors.push({ r: 55, g: 55, b: 55 });          // treat as unset
      } else {
        colors.push({ r: 55, g: 55, b: 55 });          // unknown cmd → unset
      }

      win?.webContents.send('linkm:burnProgress', i, 48);
      await sleep(50);
    }

    // Prefer ticks from color lines; fall back to inferring from fade speed.
    const ticks = detectedTicks
      ?? (detectedFadeSpeed !== null ? closestTicksForFadeSpeed(detectedFadeSpeed) : 1);

    win?.webContents.send('linkm:burnProgress', 48, 48);
    return { ok: true, colors, ticks };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Save sequence to file (native save dialog)
ipcMain.handle('seq:save', async (_, data) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save Sequence',
    defaultPath: 'blinkm-sequence.json',
    filters: [{ name: 'BlinkM Sequence', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Open sequence file (native open dialog)
ipcMain.handle('seq:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open Sequence',
    filters: [{ name: 'BlinkM Sequence', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false };
  try {
    const raw  = fs.readFileSync(filePaths[0], 'utf8');
    const data = JSON.parse(raw);
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Window ─────────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 860,
    height: 560,
    resizable: false,
    title: 'BlinkM Sequencer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
  if (process.env.BLINKM_DEVTOOLS) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.openDevTools({ mode: 'detach', activate: true });
      win.webContents.devToolsWebContents?.executeJavaScript(
        'DevToolsAPI.showPanel("console")'
      );
    });
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  lm.disconnect();
  app.quit();
});
