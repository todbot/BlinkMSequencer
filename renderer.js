'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const NUM_SLICES  = 48;
const DEFAULT_RGB = { r: 55, g: 55, b: 55 };  // "unset" tile color (tlDarkGray)

// ── App state ────────────────────────────────────────────────────────────────
let sliceColors = Array.from({ length: NUM_SLICES }, () => ({ ...DEFAULT_RGB }));
let selected    = new Set([0]);   // start with first slice selected
let isPlaying   = false;
let isLoop      = true;
let duration    = 1;       // BlinkM ticks (1=3s, 18=30s, 72=120s)

// ticks → wall-clock seconds, used only for the playback animation timer
const TICK_SECONDS = { 1: 3, 18: 30, 72: 120 };
let isConnected = false;
let isDragging  = false;
let dragAnchor  = 0;
let playRafId   = null;
let playStart   = 0;       // performance.now() timestamp
let lastPlayIdx = -1;      // last slice index sent to hardware

// LED preview fade state — mirrors ColorPreview.pde's ColorFader (step=25, 25ms tick)
let ledCurr = { ...DEFAULT_RGB };
let ledTarg = { ...DEFAULT_RGB };
const FADE_STEP = 25;
setInterval(fadeTick, 25);

// ── DOM refs ─────────────────────────────────────────────────────────────────
const timelineEl  = document.getElementById('timeline');
const playheadEl  = document.getElementById('playhead');
const playBtn     = document.getElementById('play-btn');
const uploadBtn   = document.getElementById('upload-btn');
const downloadBtn = document.getElementById('download-btn');
const openBtn     = document.getElementById('open-btn');
const saveBtn     = document.getElementById('save-btn');   // "Save…"
const connectBtn  = document.getElementById('connect-btn');
const loopCheck   = document.getElementById('loop-check');
const speedSelect = document.getElementById('speed-select');
const colorPicker = document.getElementById('color-picker');
const hexInput    = document.getElementById('hex-input');
const ledEl       = document.getElementById('led');
const connStatus  = document.getElementById('conn-status');
const overlay     = document.getElementById('overlay');
const overlayMsg  = document.getElementById('overlay-msg');
const overlayProg = document.getElementById('overlay-progress');
const overlaySub  = document.getElementById('overlay-sub');
const overlayOk   = document.getElementById('overlay-ok');

// ── Timeline ─────────────────────────────────────────────────────────────────

function buildTimeline() {
  // Insert 48 slice cells before the playhead div
  for (let i = 0; i < NUM_SLICES; i++) {
    const el = document.createElement('div');
    el.className = 'slice' + ((i + 1) % 8 === 0 ? ' tick' : '');
    el.dataset.i = i;
    setCellBg(el, sliceColors[i]);
    el.addEventListener('mousedown',  e => onSliceDown(e, i));
    el.addEventListener('mouseenter', ()  => onSliceEnter(i));
    el.addEventListener('dblclick',   ()  => onSliceDblClick(i));
    timelineEl.insertBefore(el, playheadEl);
  }
  document.addEventListener('mouseup', () => { isDragging = false; });
  refreshSelected();
  positionPlayhead(0);
}

function cellEl(i) {
  return timelineEl.querySelector(`.slice[data-i="${i}"]`);
}

function setCellBg(el, { r, g, b }) {
  el.style.backgroundColor = `rgb(${r},${g},${b})`;
}

function refreshSelected() {
  timelineEl.querySelectorAll('.slice').forEach((el, i) => {
    el.classList.toggle('selected', selected.has(i));
  });
}

// Place the playhead at a fractional progress position (0.0 → 1.0)
function positionPlayhead(progress) {
  const wrap   = document.getElementById('timeline-wrap');
  const totalW = wrap.offsetWidth;
  const usable = totalW - 36;   // subtract 18px left + 18px right padding
  playheadEl.style.left = (18 + progress * usable) + 'px';
}

// ── Timeline interaction ──────────────────────────────────────────────────────

function onSliceDown(e, i) {
  if (e.metaKey || e.ctrlKey) {
    // Cmd/Ctrl+click: toggle individual slice
    selected.has(i) ? selected.delete(i) : selected.add(i);
  } else {
    selected.clear();
    selected.add(i);
    isDragging = true;
    dragAnchor = i;
  }
  refreshSelected();
  e.preventDefault();
}

function onSliceEnter(i) {
  if (!isDragging) return;
  const lo = Math.min(dragAnchor, i);
  const hi = Math.max(dragAnchor, i);
  selected.clear();
  for (let j = lo; j <= hi; j++) selected.add(j);
  refreshSelected();
}

function onSliceDblClick(i) {
  selected.add(i);
  const { r, g, b } = sliceColors[i];
  const hex = rgbToHex(r, g, b);
  colorPicker.value = hex;
  hexInput.value    = hex;
  colorPicker.click();  // open native OS color picker
}

// ── Color logic ───────────────────────────────────────────────────────────────

function applyColor(r, g, b) {
  selected.forEach(i => {
    sliceColors[i] = { r, g, b };
    setCellBg(cellEl(i), { r, g, b });
  });
  setLedTarget(r, g, b);
  if (isConnected) window.linkm.sendColor(r, g, b);
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

// ── Swatch palette (16 × 8 = 128 swatches) ───────────────────────────────────

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const rs = [v, q, p, p, t, v];
  const gs = [t, v, v, q, p, p];
  const bs = [p, p, t, v, v, q];
  const k  = i % 6;
  return {
    r: Math.round(rs[k] * 255),
    g: Math.round(gs[k] * 255),
    b: Math.round(bs[k] * 255),
  };
}

function buildSwatches() {
  const grid = document.getElementById('swatch-grid');
  const COLS = 16;

  // 6 rows: full-saturation hues at decreasing value (brightness)
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < COLS; col++) {
      addSwatch(grid, hsvToRgb(col / COLS, 1.0, 1.0 - row * 0.13));
    }
  }
  // Row 7: pastel (low saturation)
  for (let col = 0; col < COLS; col++) {
    addSwatch(grid, hsvToRgb(col / COLS, 0.35, 1.0));
  }
  // Row 8: grayscale
  for (let col = 0; col < COLS; col++) {
    const v = Math.round((col / (COLS - 1)) * 255);
    addSwatch(grid, { r: v, g: v, b: v });
  }
}

function addSwatch(container, { r, g, b }) {
  const el = document.createElement('div');
  el.className = 'swatch';
  el.style.backgroundColor = `rgb(${r},${g},${b})`;
  el.addEventListener('click', () => {
    const hex = rgbToHex(r, g, b);
    colorPicker.value = hex;
    hexInput.value    = hex;
    applyColor(r, g, b);
  });
  container.appendChild(el);
}

// ── LED preview fade (mirrors ColorPreview.pde's ColorFader) ──────────────────

function setLedTarget(r, g, b) { ledTarg = { r, g, b }; }

function fadeTick() {
  const slide = (c, t) => {
    const d = t - c;
    if (Math.abs(d) <= FADE_STEP) return t;
    return c + (d > 0 ? FADE_STEP : -FADE_STEP);
  };
  ledCurr.r = slide(ledCurr.r, ledTarg.r);
  ledCurr.g = slide(ledCurr.g, ledTarg.g);
  ledCurr.b = slide(ledCurr.b, ledTarg.b);
  const { r, g, b } = ledCurr;
  ledEl.style.backgroundColor = `rgb(${r},${g},${b})`;
}

// ── Playback ──────────────────────────────────────────────────────────────────
// Uses requestAnimationFrame + elapsed time so the playhead position is derived
// from a single source of truth (avoids the drift the original Processing app
// worked around with its durtmp+1 fudge factor).

function startPlay() {
  isPlaying = true;
  playStart = performance.now();
  playBtn.textContent = '■  Stop';
  playBtn.classList.add('playing');
  window.linkm.preparePreview(duration);
  scheduleFrame();
}

function stopPlay() {
  isPlaying   = false;
  lastPlayIdx = -1;
  if (playRafId) { cancelAnimationFrame(playRafId); playRafId = null; }
  playBtn.textContent = '▶  Play';
  playBtn.classList.remove('playing');
  positionPlayhead(0);
}

function scheduleFrame() {
  playRafId = requestAnimationFrame(() => {
    if (!isPlaying) return;

    let progress = (performance.now() - playStart) / ((TICK_SECONDS[duration] ?? 3) * 1000);

    if (progress >= 1.0) {
      if (isLoop) {
        playStart = performance.now();
        progress  = 0;
      } else {
        stopPlay();
        return;
      }
    }

    positionPlayhead(progress);

    const idx = Math.min(NUM_SLICES - 1, Math.floor(progress * NUM_SLICES));
    const c   = sliceColors[idx];
    setLedTarget(c.r, c.g, c.b);
    if (isConnected && idx !== lastPlayIdx) {
      lastPlayIdx = idx;
      const isUnset = c.r === DEFAULT_RGB.r && c.g === DEFAULT_RGB.g && c.b === DEFAULT_RGB.b;
      window.linkm.sendColor(isUnset ? 0 : c.r, isUnset ? 0 : c.g, isUnset ? 0 : c.b);
    }

    scheduleFrame();
  });
}

// ── Upload / Download ─────────────────────────────────────────────────────────

function showOverlay(msg, total) {
  overlayMsg.textContent = msg;
  overlayProg.value      = 0;
  overlayProg.max        = total;
  overlaySub.textContent = '';
  overlayOk.classList.add('hidden');
  overlay.classList.remove('hidden');
}

async function doUpload() {
  if (!isConnected) { alert('Please connect a LinkM device first.'); return; }
  showOverlay('Writing sequence to BlinkM\u2026', NUM_SLICES);
  uploadBtn.disabled = true;

  const result = await window.linkm.burn(sliceColors, duration, isLoop);

  overlaySub.textContent = result.ok
    ? 'Done. BlinkM will play this sequence on power-up.'
    : 'Error: ' + result.error;
  overlayOk.classList.remove('hidden');
  uploadBtn.disabled = false;
}

async function doDownload() {
  if (!isConnected) { alert('Please connect a LinkM device first.'); return; }
  showOverlay('Reading sequence from BlinkM\u2026', NUM_SLICES);
  downloadBtn.disabled = true;

  const result = await window.linkm.download();

  if (result.ok) {
    loadColors(result.colors);
    if (result.ticks) {
      duration          = result.ticks;
      speedSelect.value = String(duration);
    }
    overlaySub.textContent = 'Done.';
  } else {
    overlaySub.textContent = 'Error: ' + result.error;
  }
  overlayOk.classList.remove('hidden');
  downloadBtn.disabled = false;
}

// ── Open / Save ───────────────────────────────────────────────────────────────

// JSON format: { version: 1, duration: 1, loop: true, colors: [{r,g,b}×48] }
// duration is in BlinkM ticks (1=3s, 18=30s, 72=120s)

async function doSave() {
  await window.linkm.save({ version: 1, duration, loop: isLoop, colors: sliceColors });
}

async function doOpen() {
  const result = await window.linkm.open();
  if (!result.ok) return;
  const { data } = result;
  if (!Array.isArray(data.colors) || data.colors.length !== NUM_SLICES) {
    alert('Invalid sequence file.');
    return;
  }
  loadColors(data.colors);
  if (typeof data.duration === 'number') {
    duration = data.duration;
    speedSelect.value = String(duration);
  }
  if (typeof data.loop === 'boolean') {
    isLoop = data.loop;
    loopCheck.checked = isLoop;
  }
}

// Replace all slice colors and refresh the timeline
function loadColors(colors) {
  sliceColors = colors.map(({ r, g, b }) => ({ r, g, b }));
  timelineEl.querySelectorAll('.slice').forEach((el, i) => setCellBg(el, sliceColors[i]));
}

// ── Connection ────────────────────────────────────────────────────────────────

async function connect() {
  const r = await window.linkm.connect();
  if (r.ok) {
    isConnected = true;
    setConnStatus('connected');
    connectBtn.textContent = 'Disconnect LinkM';
  } else {
    alert('Connect failed: ' + r.error);
  }
}

async function disconnect() {
  await window.linkm.disconnect();
  isConnected = false;
  setConnStatus('disconnected');
  connectBtn.textContent = 'Connect LinkM';
}

function setConnStatus(state) {
  connStatus.className   = state;
  connStatus.textContent = state === 'connected' ? 'LinkM connected' : 'No LinkM, Disconnected';
}

// ── Event wiring ──────────────────────────────────────────────────────────────

playBtn.addEventListener('click',     () => { if (isPlaying) stopPlay(); else startPlay(); });
uploadBtn.addEventListener('click',   doUpload);
downloadBtn.addEventListener('click', doDownload);
openBtn.addEventListener('click',     doOpen);
saveBtn.addEventListener('click',     doSave);
overlayOk.addEventListener('click',   () => overlay.classList.add('hidden'));
connectBtn.addEventListener('click',  () => { if (isConnected) disconnect(); else connect(); });

loopCheck.addEventListener('change', () => { isLoop = loopCheck.checked; });

speedSelect.addEventListener('change', () => {
  duration = parseInt(speedSelect.value, 10);
  if (isConnected) window.linkm.preparePreview(duration);
});

colorPicker.addEventListener('input', () => {
  const hex = colorPicker.value;
  hexInput.value = hex;
  const c = hexToRgb(hex);
  if (c) applyColor(c.r, c.g, c.b);
});

hexInput.addEventListener('change', () => {
  const raw = hexInput.value.trim();
  const hex = raw.startsWith('#') ? raw : '#' + raw;
  const c   = hexToRgb(hex);
  if (c) {
    colorPicker.value = rgbToHex(c.r, c.g, c.b);
    hexInput.value    = rgbToHex(c.r, c.g, c.b);
    applyColor(c.r, c.g, c.b);
  }
});

// Push events from main process (only 'disconnected' — fired when device errors/unplugs)
window.linkm.onStatus(state => {
  if (state === 'disconnected') {
    isConnected = false;
    setConnStatus('disconnected');
    connectBtn.textContent = 'Connect LinkM';
  }
});

window.linkm.onBurnProgress((cur, _tot) => {
  overlayProg.value = cur;
});

// ── Init ──────────────────────────────────────────────────────────────────────

buildSwatches();
buildTimeline();

// Auto-connect if a LinkM is already plugged in at launch
window.linkm.status().then(({ devicePresent }) => {
  if (devicePresent) connect();
});
