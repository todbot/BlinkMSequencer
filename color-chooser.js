// SPDX-FileCopyrightText: Copyright (c) 2026 Tod Kurt / ThingM
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

// ── Color math (pure functions) ───────────────────────────────────────────────

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

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

// ── Color Chooser ─────────────────────────────────────────────────────────────
// initColorChooser(onColorPicked) — call once at startup.
//   onColorPicked(r, g, b) fires when the user actively picks a color.
//   Returns { sync(r, g, b), openNativePicker() } for the host to call:
//     sync            — push a color into all inputs without firing onColorPicked
//     openNativePicker — programmatically open the OS color picker (dblclick)

function initColorChooser(onColorPicked) {

  // DOM refs (private to this module)
  const colorPicker = document.getElementById('color-picker');
  const hexInput    = document.getElementById('hex-input');
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

  // ── Swatch palette ───────────────────────────────────────────────────────

  function highlightSwatch(r, g, b) {
    document.querySelectorAll('.swatch.active').forEach(el => el.classList.remove('active'));
    const match = document.querySelector(
      `.swatch[data-r="${r}"][data-g="${g}"][data-b="${b}"]`
    );
    if (match) match.classList.add('active');
  }

  function addSwatch(container, { r, g, b }) {
    const el = document.createElement('div');
    el.className = 'swatch';
    el.dataset.r = r;
    el.dataset.g = g;
    el.dataset.b = b;
    el.style.backgroundColor = `rgb(${r},${g},${b})`;
    el.addEventListener('click', () => {
      sync(r, g, b);
      onColorPicked(r, g, b);
    });
    container.appendChild(el);
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

  // ── Display sync ─────────────────────────────────────────────────────────

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

  // Push an r,g,b into all color inputs without firing onColorPicked
  function sync(r, g, b) {
    const hex = rgbToHex(r, g, b);
    colorPicker.value = hex;
    hexInput.value    = hex;
    highlightSwatch(r, g, b);

    rgbR.value = r; rgbRVal.value = r;
    rgbG.value = g; rgbGVal.value = g;
    rgbB.value = b; rgbBVal.value = b;

    const { h, s, v } = rgbToHsv(r, g, b);
    hsbH.value = Math.round(h * 359); hsbHVal.value = Math.round(h * 359);
    hsbS.value = Math.round(s * 100); hsbSVal.value = Math.round(s * 100);
    hsbBSlider.value = Math.round(v * 100); hsbBVal.value = Math.round(v * 100);
    updateHsbTracks(h, s, v);
  }

  // ── Slider / input event handlers ────────────────────────────────────────

  function applyHsbSliders() {
    const h = parseInt(hsbH.value, 10) / 359;
    const s = parseInt(hsbS.value, 10) / 100;
    const v = parseInt(hsbBSlider.value, 10) / 100;
    const { r, g, b } = hsvToRgb(h, s, v);
    colorPicker.value = rgbToHex(r, g, b);
    hexInput.value    = rgbToHex(r, g, b);
    hsbHVal.value = hsbH.value;
    hsbSVal.value = hsbS.value;
    hsbBVal.value = hsbBSlider.value;
    updateHsbTracks(h, s, v);
    rgbR.value = r; rgbRVal.value = r;
    rgbG.value = g; rgbGVal.value = g;
    rgbB.value = b; rgbBVal.value = b;
    highlightSwatch(r, g, b);
    onColorPicked(r, g, b);
  }

  function applyRgbSliders() {
    const r = parseInt(rgbR.value, 10);
    const g = parseInt(rgbG.value, 10);
    const b = parseInt(rgbB.value, 10);
    colorPicker.value = rgbToHex(r, g, b);
    hexInput.value    = rgbToHex(r, g, b);
    rgbRVal.value = r;
    rgbGVal.value = g;
    rgbBVal.value = b;
    const { h, s, v } = rgbToHsv(r, g, b);
    hsbH.value = Math.round(h * 359); hsbHVal.value = Math.round(h * 359);
    hsbS.value = Math.round(s * 100); hsbSVal.value = Math.round(s * 100);
    hsbBSlider.value = Math.round(v * 100); hsbBVal.value = Math.round(v * 100);
    updateHsbTracks(h, s, v);
    highlightSwatch(r, g, b);
    onColorPicked(r, g, b);
  }

  // ── Event wiring ─────────────────────────────────────────────────────────

  document.querySelectorAll('.color-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
    });
  });

  [hsbH, hsbS, hsbBSlider].forEach(el => el.addEventListener('input', applyHsbSliders));
  hsbHVal.addEventListener('change', () => { hsbH.value = hsbHVal.value; applyHsbSliders(); });
  hsbSVal.addEventListener('change', () => { hsbS.value = hsbSVal.value; applyHsbSliders(); });
  hsbBVal.addEventListener('change', () => { hsbBSlider.value = hsbBVal.value; applyHsbSliders(); });

  [rgbR, rgbG, rgbB].forEach(el => el.addEventListener('input', applyRgbSliders));
  rgbRVal.addEventListener('change', () => { rgbR.value = rgbRVal.value; applyRgbSliders(); });
  rgbGVal.addEventListener('change', () => { rgbG.value = rgbGVal.value; applyRgbSliders(); });
  rgbBVal.addEventListener('change', () => { rgbB.value = rgbBVal.value; applyRgbSliders(); });

  colorPicker.addEventListener('input', () => {
    const c = hexToRgb(colorPicker.value);
    if (c) { hexInput.value = colorPicker.value; sync(c.r, c.g, c.b); onColorPicked(c.r, c.g, c.b); }
  });

  hexInput.addEventListener('change', () => {
    const raw = hexInput.value.trim();
    const hex = raw.startsWith('#') ? raw : '#' + raw;
    const c   = hexToRgb(hex);
    if (c) { sync(c.r, c.g, c.b); onColorPicked(c.r, c.g, c.b); }
  });

  // ── Init ─────────────────────────────────────────────────────────────────

  buildSwatches();

  return {
    sync,
    openNativePicker: () => colorPicker.click(),
  };
}
