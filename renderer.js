// SPDX-FileCopyrightText: Copyright (c) 2026 Tod Kurt / ThingM
// SPDX-License-Identifier: GPL-3.0-or-later
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
let isConnected   = false;
let isDragging    = false;
let clipboard     = null;   // array of {r,g,b} in sorted-index order, or null
let undoSnapshot  = null;   // full sliceColors snapshot before last cut/paste
let dragAnchor  = 0;
let playRafId   = null;
let playStart   = 0;       // performance.now() timestamp
let lastPlayIdx = -1;      // last slice index sent to hardware

// LED preview fade state — mirrors ColorPreview.pde's ColorFader (step=25, 25ms tick)
let ledCurr = { ...DEFAULT_RGB };
let ledTarg = { ...DEFAULT_RGB };
const FADE_STEP = 25;
setInterval(fadeTick, 25);

let colorChooser;   // set during init

// ── DOM refs ─────────────────────────────────────────────────────────────────
const timelineEl  = document.getElementById('timeline');
const playheadEl  = document.getElementById('playhead');
const playBtn     = document.getElementById('play-btn');
const uploadBtn   = document.getElementById('upload-btn');
const downloadBtn = document.getElementById('download-btn');
const openBtn     = document.getElementById('open-btn');
const saveBtn     = document.getElementById('save-btn');
const connectBtn  = document.getElementById('connect-btn');
const loopCheck   = document.getElementById('loop-check');
const speedSelect = document.getElementById('speed-select');
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
    colorChooser.sync(r, g, b);
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
  colorChooser.sync(r, g, b);
  colorChooser.openNativePicker();
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
      colorChooser.sync(c.r, c.g, c.b);
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

// ── Cut / Paste / Undo ────────────────────────────────────────────────────────

function snapshotColors() {
  return sliceColors.map(c => ({ ...c }));
}

function sortedSelected() {
  return [...selected].sort((a, b) => a - b);
}

function copySlices() {
  const indices = sortedSelected();
  if (!indices.length) return;
  clipboard = indices.map(i => ({ ...sliceColors[i] }));
}

function cutSlices() {
  const indices = sortedSelected();
  if (!indices.length) return;
  undoSnapshot = snapshotColors();
  clipboard = indices.map(i => ({ ...sliceColors[i] }));
  indices.forEach(i => {
    sliceColors[i] = { ...DEFAULT_RGB };
    setCellBg(cellEl(i), DEFAULT_RGB);
  });
}

function pasteSlices() {
  if (!clipboard) return;
  const start = Math.min(...selected);
  const end   = Math.min(start + clipboard.length - 1, NUM_SLICES - 1);
  undoSnapshot = snapshotColors();
  for (let i = start; i <= end; i++) {
    const c = clipboard[i - start];
    sliceColors[i] = { ...c };
    setCellBg(cellEl(i), c);
  }
  colorChooser.sync(clipboard[0].r, clipboard[0].g, clipboard[0].b);
}

function undoSlices() {
  if (!undoSnapshot) return;
  sliceColors = undoSnapshot;
  undoSnapshot = null;
  timelineEl.querySelectorAll('.slice').forEach((el, i) => setCellBg(el, sliceColors[i]));
  const indices = sortedSelected();
  if (indices.length) {
    const c = sliceColors[indices[0]];
    colorChooser.sync(c.r, c.g, c.b);
  }
}

window.linkm.onEditAction(action => {
  if (action === 'copy')  copySlices();
  if (action === 'cut')   cutSlices();
  if (action === 'paste') pasteSlices();
  if (action === 'undo')  undoSlices();
});

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

colorChooser = initColorChooser((r, g, b) => applyColor(r, g, b));
colorChooser.sync(DEFAULT_RGB.r, DEFAULT_RGB.g, DEFAULT_RGB.b);
buildTimeline();
window.linkm.appVersion().then(v => {
  document.getElementById('app-version').textContent = `version ${v} \u00a9 ThingM Corporation`;
});

// Auto-connect if a LinkM is already plugged in at launch
window.linkm.status().then(({ devicePresent }) => {
  if (devicePresent) connect();
});
