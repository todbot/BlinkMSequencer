'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const HID  = require('node-hid');

// ── LinkM USB identifiers ──────────────────────────────────────────────────
// From linkm-lib.h: IDENT_VENDOR_NUM 0x20A0, IDENT_PRODUCT_NUM 0x4110
const LINKM_VID = 0x20A0;
const LINKM_PID = 0x4110;

// LinkM command codes (linkm-lib.h, datasheet §7.1)
const CMD_I2CTRANS   = 1;   // I2C read & write transaction
const CMD_VERSIONGET = 100; // return LinkM firmware version (unused here)

const BLINKM_ADDR = 0x09;   // default BlinkM I2C address

// Duration → BlinkM tick/fadeSpeed mapping (matches BlinkMComm.pde exactly)
const DURATION_MAP = {
  3:   { ticks: 1,  fadeSpeed: 100 },
  30:  { ticks: 18, fadeSpeed: 25  },
  120: { ticks: 72, fadeSpeed: 5   },
};

// ── State ──────────────────────────────────────────────────────────────────
let win    = null;
let device = null;

// ── HID transport ──────────────────────────────────────────────────────────
// From linkm-lib.c / hiddata.c:
//   Report ID = 1, REPORT1_SIZE = 17 (1 report-ID byte + 16 data bytes)
//   buf[0] = 1        (HID report ID)
//   buf[1] = 0xDA     (START_BYTE)
//   buf[2] = cmd
//   buf[3] = num bytes to send (i2c addr + cmd bytes)
//   buf[4] = num bytes to receive
//   buf[5..16] = payload (zero-padded)
//
// Transport: HID Feature Reports (SET_REPORT / GET_REPORT via USB control transfer)
// node-hid: sendFeatureReport() → SET_FEATURE, getFeatureReport() → GET_FEATURE

const REPORT_ID    = 1;
const START_BYTE   = 0xDA;
const REPORT1_SIZE = 17;   // must match firmware usbconfig.h

function hidCommand(cmd, sendBytes, recvLen) {
  if (!device) throw new Error('LinkM not connected');
  const buf = new Array(REPORT1_SIZE).fill(0);
  buf[0] = REPORT_ID;
  buf[1] = START_BYTE;
  buf[2] = cmd;
  buf[3] = sendBytes.length;
  buf[4] = recvLen;
  sendBytes.forEach((b, i) => { buf[5 + i] = b; });
  device.sendFeatureReport(buf);
  if (recvLen > 0) {
    // C code sleeps 50ms before reading response
    // (synchronous spin-wait since we're in a sync context here)
    const deadline = Date.now() + 60;
    while (Date.now() < deadline) { /* busy wait */ }
    const resp = device.getFeatureReport(REPORT_ID, REPORT1_SIZE);
    if (!resp || resp.length < 2) throw new Error('LinkM read failed');
    // resp[0]=reportId, resp[1]=error code, resp[2..]=data
    if (resp[1] !== 0) throw new Error(`LinkM error code: ${resp[1]}`);
    return Array.from(resp).slice(2, 2 + recvLen);
  }
  return [];
}

// Send an I2C write-only transaction to addr with BlinkM command bytes
function i2c(addr, bytes) {
  hidCommand(CMD_I2CTRANS, [addr, ...bytes], 0);
}


// ── BlinkM I2C commands (command bytes from BlinkM datasheet) ──────────────
const bm = {
  fadeToRGB:  (r, g, b)     => i2c(BLINKM_ADDR, [0x63, r, g, b]),        // 'c'
  stopScript: ()             => i2c(BLINKM_ADDR, [0x6F]),                 // 'o'
  setFadeSpeed: (speed)      => i2c(BLINKM_ADDR, [0x66, speed]),          // 'f'
  playScript: (id, reps, pos)=> i2c(BLINKM_ADDR, [0x70, id, reps, pos]), // 'p'
  // 'L': script_id, length, reps
  setScriptLength: (id, len, reps) => i2c(BLINKM_ADDR, [0x4C, id, len, reps]),
  // 'B': mode=1(play on boot), script_id=0, reps=0, fadeSpeed, timeAdj=reps
  setBootParams: (fadeSpeed, reps) =>
    i2c(BLINKM_ADDR, [0x42, 1, 0, 0, fadeSpeed, reps]),
  // 'W': script_id=0, line, ticks, sub_cmd='c'(0x63), r, g, b
  writeScriptLine: (line, ticks, r, g, b) =>
    i2c(BLINKM_ADDR, [0x57, 0, line, ticks, 0x63, r, g, b]),
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.handle('linkm:connect', () => {
  if (device) {
    console.log('LinkM: already connected');
    return { ok: true };
  }
  const found = HID.devices(LINKM_VID, LINKM_PID);
  console.log(`LinkM: scanning — found ${found.length} device(s)`, found.map(d => d.path));
  if (!found.length) {
    return { ok: false, error: 'No LinkM device found' };
  }
  try {
    device = new HID.HID(LINKM_VID, LINKM_PID);
    device.on('error', err => {
      console.error('LinkM HID error:', err.message);
      try { device.close(); } catch (_) {}
      device = null;
      win?.webContents.send('linkm:status', 'disconnected');
    });
    console.log('LinkM: connected');
    return { ok: true };
  } catch (e) {
    console.error('LinkM: open failed —', e.message);
    device = null;
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('linkm:disconnect', () => {
  try { device?.close(); } catch (_) {}
  device = null;
  return { ok: true };
});

ipcMain.handle('linkm:status', () => ({
  connected:     !!device,
  devicePresent: HID.devices(LINKM_VID, LINKM_PID).length > 0,
}));

// Live color update during playback preview.
// Rate-limited and deduplicated — mirrors BlinkMComm.sendColor()'s
// "don't clog the pipes" guard + pause(10).
let lastSentRgb  = null;
let lastSentTime = 0;
const MIN_SEND_MS = 30;   // don't send faster than ~33 Hz

ipcMain.handle('linkm:sendColor', (_, r, g, b) => {
  const now = Date.now();
  if (lastSentRgb &&
      lastSentRgb[0] === r && lastSentRgb[1] === g && lastSentRgb[2] === b) {
    return { ok: true };  // same color, skip
  }
  if (now - lastSentTime < MIN_SEND_MS) {
    return { ok: true };  // too soon, drop
  }
  try {
    bm.fadeToRGB(r, g, b);
    lastSentRgb  = [r, g, b];
    lastSentTime = Date.now();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Prepare BlinkM for preview (stop current script, set fade speed)
ipcMain.handle('linkm:preparePreview', (_, duration) => {
  try {
    if (!device) return { ok: true };
    const p = DURATION_MAP[duration] ?? DURATION_MAP[3];
    bm.stopScript();
    setTimeout(() => { try { bm.setFadeSpeed(p.fadeSpeed); } catch (_) {} }, 40);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Burn sequence to BlinkM EEPROM — replicates BlinkMComm.burn() exactly
const NULL_COLOR = { r: 55, g: 55, b: 55 }; // unset tile → write black

ipcMain.handle('linkm:burn', async (_, colors, duration, loop) => {
  try {
    const p    = DURATION_MAP[duration] ?? DURATION_MAP[3];
    const reps = loop ? 0 : 1;  // BlinkM: 0=loop forever, 1=play once

    for (let i = 0; i < colors.length; i++) {
      let { r, g, b } = colors[i];
      if (r === NULL_COLOR.r && g === NULL_COLOR.g && b === NULL_COLOR.b) {
        r = g = b = 0;  // unset slices burn as black
      }
      bm.writeScriptLine(i, p.ticks, r, g, b);
      win?.webContents.send('linkm:burnProgress', i, colors.length);
      await sleep(50);  // required EEPROM write cycle time
    }

    bm.setScriptLength(0, colors.length, reps);
    await sleep(50);
    bm.setBootParams(p.fadeSpeed, reps);
    await sleep(50);
    bm.setFadeSpeed(p.fadeSpeed);
    await sleep(30);
    bm.playScript(0, reps, 0);
    await sleep(30);

    win?.webContents.send('linkm:burnProgress', colors.length, colors.length);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Read sequence back from BlinkM EEPROM
// 'R' (0x52): readScriptLine — returns [ticks, cmd, arg1, arg2, arg3]
// When cmd is 0x63 (fadeToRGB), arg1/2/3 are r, g, b.
ipcMain.handle('linkm:download', async () => {
  try {
    // Stop any running script first to avoid I2C conflicts during reads
    bm.stopScript();
    await sleep(100);

    const colors = [];
    for (let i = 0; i < 48; i++) {
      const data = hidCommand(CMD_I2CTRANS, [BLINKM_ADDR, 0x52, 0, i], 5);
      colors.push({ r: data[2], g: data[3], b: data[4] });
      win?.webContents.send('linkm:burnProgress', i, 48);
      await sleep(50);
    }

    win?.webContents.send('linkm:burnProgress', 48, 48);
    return { ok: true, colors };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Save sequence to a file (shows native save dialog)
ipcMain.handle('seq:save', async (_, data) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save Sequence',
    defaultPath: 'sequence.blinkm',
    filters: [{ name: 'BlinkM Sequence', extensions: ['blinkm'] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Open a sequence file (shows native open dialog)
ipcMain.handle('seq:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open Sequence',
    filters: [{ name: 'BlinkM Sequence', extensions: ['blinkm'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false };
  try {
    const raw  = fs.readFileSync(filePaths[0], 'utf8');
    const data = JSON.parse(raw);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Window ─────────────────────────────────────────────────────────────────

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
  try { device?.close(); } catch (_) {}
  app.quit();
});
