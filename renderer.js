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
const hsbH        = document.getElementById('hsb-h');
const hsbHVal     = document.getElementById('hsb-h-val');
const hsbS        = document.getElementById('hsb-s');
const hsbSVal     = document.getElementById('hsb-s-val');
const hsbBSlider  = document.getElementById('hsb-b');
const hsbBVal     = document.getElementById('hsb-b-val');
const rgbR        = document.getElementById('rgb-r');
const rgbRVal     = document.getElementById('rgb-r-val');
const rgbG        = document.getElementById('rgb-g');
const rgbGVal     = document.getElementById('rgb-g-val');
const rgbB        = document.getElementById('rgb-b');
const rgbBVal     = document.getElementById('rgb-b-val');
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

// Scrub the playhead to a client X coordinate
function scrubTo(clientX) {
  const wrap    = document.getElementById('timeline-wrap');
  const rect    = wrap.getBoundingClientRect();
  const usable  = rect.width - 36;
  const progress = Math.max(0, Math.min(1, (clientX - rect.left - 18) / usable));
  positionPlayhead(progress);
  if (isPlaying) {
    playStart = performance.now() - progress * (TICK_SECONDS[duration] ?? 3) * 1000;
  }
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
    const { r, g, b } = sliceColors[i];
    syncColorInputs(r, g, b);
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
  syncColorInputs(r, g, b);
  colorPicker.click();  // open native OS color picker
}

// ── Color logic ───────────────────────────────────────────────────────────────

function highlightSwatch(r, g, b) {
  document.querySelectorAll('.swatch.active').forEach(el => el.classList.remove('active'));
  const match = document.querySelector(
    `.swatch[data-r="${r}"][data-g="${g}"][data-b="${b}"]`
  );
  if (match) match.classList.add('active');
}

// Update all color input widgets to reflect an r,g,b value (without applying to slices)
function syncColorInputs(r, g, b) {
  const hex = rgbToHex(r, g, b);
  colorPicker.value = hex;
  hexInput.value    = hex;
  highlightSwatch(r, g, b);

  rgbR.value = r; rgbRVal.value = r;
  rgbG.value = g; rgbGVal.value = g;
  rgbB.value = b; rgbBVal.value = b;

  const { h, s, v } = rgbToHsv(r, g, b);
  const hDeg = Math.round(h * 359);
  const sPct = Math.round(s * 100);
  const vPct = Math.round(v * 100);
  hsbH.value = hDeg;   hsbHVal.value = hDeg;
  hsbS.value = sPct;   hsbSVal.value = sPct;
  hsbBSlider.value = vPct; hsbBVal.value = vPct;
  updateHsbTracks(h, s, v);
}

// Update HSB slider track gradient backgrounds to reflect current hue/sat/val
function updateHsbTracks(h, s, v) {
  const hDeg = h * 360;
  hsbH.style.background =
    'linear-gradient(to right,hsl(0,100%,50%),hsl(60,100%,50%),hsl(120,100%,50%),hsl(180,100%,50%),hsl(240,100%,50%),hsl(300,100%,50%),hsl(360,100%,50%))';
  hsbS.style.background =
    `linear-gradient(to right,hsl(${hDeg},0%,50%),hsl(${hDeg},100%,50%))`;
  const { r: fr, g: fg, b: fb } = hsvToRgb(h, s, 1.0);
  hsbBSlider.style.background =
    `linear-gradient(to right,#000,rgb(${fr},${fg},${fb}))`;
}

function applyColor(r, g, b) {
  selected.forEach(i => {
    sliceColors[i] = { r, g, b };
    setCellBg(cellEl(i), { r, g, b });
  });
  setLedTarget(r, g, b);
  highlightSwatch(r, g, b);
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

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if      (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else                h = ((r - g) / d + 4) / 6;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function buildSwatches() {
  const grid = document.getElementById('swatch-grid');
  const COLS = 24;

  // Row 1: pastel (low saturation)
  for (let col = 0; col < COLS; col++) {
    addSwatch(grid, hsvToRgb(col / COLS, 0.35, 1.0));
  }
  // 7 rows: full-saturation hues at decreasing value (brightness)
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < COLS; col++) {
      addSwatch(grid, hsvToRgb(col / COLS, 1.0, 1.0 - row * 0.13));
    }
  }
  // Row 9: grayscale
  for (let col = 0; col < COLS; col++) {
    const v = Math.round((col / (COLS - 1)) * 255);
    addSwatch(grid, { r: v, g: v, b: v });
  }
}

function addSwatch(container, { r, g, b }) {
  const el = document.createElement('div');
  el.className = 'swatch';
  el.dataset.r = r;
  el.dataset.g = g;
  el.dataset.b = b;
  el.style.backgroundColor = `rgb(${r},${g},${b})`;
  el.addEventListener('click', () => {
    syncColorInputs(r, g, b);
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
    if (idx !== lastPlayIdx) {
      lastPlayIdx = idx;
      syncColorInputs(c.r, c.g, c.b);
      const isUnset = c.r === DEFAULT_RGB.r && c.g === DEFAULT_RGB.g && c.b === DEFAULT_RGB.b;
      if (isConnected) {
        window.linkm.sendColor(isUnset ? 0 : c.r, isUnset ? 0 : c.g, isUnset ? 0 : c.b);
      }
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
  if (isPlaying) stopPlay();
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

const scrubBar = document.getElementById('scrub-bar');
let isScrubbing = false;
scrubBar.addEventListener('mousedown', e => {
  isScrubbing = true;
  scrubTo(e.clientX);
  e.preventDefault();
});
document.addEventListener('mousemove', e => { if (isScrubbing) scrubTo(e.clientX); });
document.addEventListener('mouseup',   () => { isScrubbing = false; });

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

// Tab switching
document.querySelectorAll('.color-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
  });
});

// HSB slider helpers
function applyHsbSliders() {
  const h = parseInt(hsbH.value, 10) / 359;
  const s = parseInt(hsbS.value, 10) / 100;
  const v = parseInt(hsbBSlider.value, 10) / 100;
  const { r, g, b } = hsvToRgb(h, s, v);
  const hex = rgbToHex(r, g, b);
  colorPicker.value = hex;
  hexInput.value    = hex;
  hsbHVal.value = hsbH.value;
  hsbSVal.value = hsbS.value;
  hsbBVal.value = hsbBSlider.value;
  updateHsbTracks(h, s, v);
  // sync RGB tab too
  rgbR.value = r; rgbRVal.value = r;
  rgbG.value = g; rgbGVal.value = g;
  rgbB.value = b; rgbBVal.value = b;
  applyColor(r, g, b);
}

[hsbH, hsbS, hsbBSlider].forEach(el => el.addEventListener('input', applyHsbSliders));
hsbHVal.addEventListener('change', () => { hsbH.value = hsbHVal.value; applyHsbSliders(); });
hsbSVal.addEventListener('change', () => { hsbS.value = hsbSVal.value; applyHsbSliders(); });
hsbBVal.addEventListener('change', () => { hsbBSlider.value = hsbBVal.value; applyHsbSliders(); });

// RGB slider helpers
function applyRgbSliders() {
  const r = parseInt(rgbR.value, 10);
  const g = parseInt(rgbG.value, 10);
  const b = parseInt(rgbB.value, 10);
  const hex = rgbToHex(r, g, b);
  colorPicker.value = hex;
  hexInput.value    = hex;
  rgbRVal.value = r;
  rgbGVal.value = g;
  rgbBVal.value = b;
  // sync HSB tab too
  const { h, s, v } = rgbToHsv(r, g, b);
  hsbH.value = Math.round(h * 359); hsbHVal.value = Math.round(h * 359);
  hsbS.value = Math.round(s * 100); hsbSVal.value = Math.round(s * 100);
  hsbBSlider.value = Math.round(v * 100); hsbBVal.value = Math.round(v * 100);
  updateHsbTracks(h, s, v);
  applyColor(r, g, b);
}

[rgbR, rgbG, rgbB].forEach(el => el.addEventListener('input', applyRgbSliders));
rgbRVal.addEventListener('change', () => { rgbR.value = rgbRVal.value; applyRgbSliders(); });
rgbGVal.addEventListener('change', () => { rgbG.value = rgbGVal.value; applyRgbSliders(); });
rgbBVal.addEventListener('change', () => { rgbB.value = rgbBVal.value; applyRgbSliders(); });

colorPicker.addEventListener('input', () => {
  const c = hexToRgb(colorPicker.value);
  if (c) { hexInput.value = colorPicker.value; syncColorInputs(c.r, c.g, c.b); applyColor(c.r, c.g, c.b); }
});

hexInput.addEventListener('change', () => {
  const raw = hexInput.value.trim();
  const hex = raw.startsWith('#') ? raw : '#' + raw;
  const c   = hexToRgb(hex);
  if (c) { syncColorInputs(c.r, c.g, c.b); applyColor(c.r, c.g, c.b); }
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
syncColorInputs(DEFAULT_RGB.r, DEFAULT_RGB.g, DEFAULT_RGB.b);

// Auto-connect if a LinkM is already plugged in at launch
window.linkm.status().then(({ devicePresent }) => {
  if (devicePresent) connect();
});
