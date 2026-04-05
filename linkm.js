// SPDX-FileCopyrightText: Copyright (c) 2026 Tod Kurt / ThingM
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// ── LinkM USB HID driver + BlinkM I2C command set ─────────────────────────────
// Protocol source: linkm-lib.c / hiddata.c (ThingM)
//
// Usage:
//   const { LinkM } = require('./linkm');
//   const lm = new LinkM();
//   lm.connect();
//   lm.fadeToRGB(255, 0, 0);
//   lm.on('disconnect', err => { ... });
//   lm.disconnect();

const { EventEmitter } = require('events');
const HID = require('node-hid');

// ── USB identifiers (linkm-lib.h) ─────────────────────────────────────────────
const LINKM_VID   = 0x20A0;
const LINKM_PID   = 0x4110;

// ── HID report constants (linkm-lib.c / usbconfig.h) ─────────────────────────
// buf[0] = REPORT_ID    (HID report ID)
// buf[1] = START_BYTE   (0xDA, marks start of LinkM command)
// buf[2] = cmd          (LinkM command code)
// buf[3] = nsend        (number of bytes to send, including I2C address)
// buf[4] = nrecv        (number of bytes to receive)
// buf[5..16] = payload  (zero-padded)
const REPORT_ID    = 1;
const START_BYTE   = 0xDA;
const REPORT1_SIZE = 17;    // must match firmware usbconfig.h

// ── LinkM command codes (linkm-lib.h §7.1) ───────────────────────────────────
const CMD_I2CTRANS = 1;     // I2C read/write transaction

class LinkM extends EventEmitter {
  // addr: BlinkM I2C address (default 0x09)
  constructor(addr = 0x09) {
    super();
    this._device = null;
    this._addr   = addr;
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  get isConnected() { return !!this._device; }

  // Returns array of HID device-info objects for attached LinkM devices
  static devices() {
    return HID.devices(LINKM_VID, LINKM_PID);
  }

  // Opens the first found LinkM. Throws if none present or open fails.
  // Emits 'disconnect' (err) if the device errors/unplugs after connect.
  connect() {
    if (this._device) return;
    this._device = new HID.HID(LINKM_VID, LINKM_PID);
    this._device.on('error', err => {
      try { this._device.close(); } catch (_) {}
      this._device = null;
      this.emit('disconnect', err);
    });
  }

  disconnect() {
    try { this._device?.close(); } catch (_) {}
    this._device = null;
  }

  // ── HID transport ───────────────────────────────────────────────────────────

  // Send a LinkM command and optionally read a response.
  // sendBytes: raw bytes for the LinkM payload (I2C addr + data for CMD_I2CTRANS)
  // recvLen:   number of response bytes expected (0 = write-only)
  // Returns array of recvLen bytes, or [] for write-only commands.
  _hidCommand(cmd, sendBytes, recvLen) {
    if (!this._device) throw new Error('LinkM not connected');
    const buf = new Array(REPORT1_SIZE).fill(0);
    buf[0] = REPORT_ID;
    buf[1] = START_BYTE;
    buf[2] = cmd;
    buf[3] = sendBytes.length;
    buf[4] = recvLen;
    sendBytes.forEach((b, i) => { buf[5 + i] = b; });
    this._device.sendFeatureReport(buf);
    if (recvLen > 0) {
      // The C reference implementation sleeps 50ms before reading the response.
      const deadline = Date.now() + 60;
      while (Date.now() < deadline) { /* busy-wait */ }
      const resp = this._device.getFeatureReport(REPORT_ID, REPORT1_SIZE);
      if (!resp || resp.length < 2) throw new Error('LinkM read failed');
      // resp[0] = reportId, resp[1] = LinkM error code, resp[2..] = data
      if (resp[1] !== 0) throw new Error(`LinkM error code: ${resp[1]}`);
      return Array.from(resp).slice(2, 2 + recvLen);
    }
    return [];
  }

  // I2C write-only to this.addr
  _i2c(bytes) {
    this._hidCommand(CMD_I2CTRANS, [this._addr, ...bytes], 0);
  }

  // I2C write+read to this.addr; returns recvLen bytes
  _i2cRead(bytes, recvLen) {
    return this._hidCommand(CMD_I2CTRANS, [this._addr, ...bytes], recvLen);
  }

  // ── BlinkM I2C command set (BlinkM datasheet) ────────────────────────────────

  // 'c' (0x63) — Fade to RGB color
  fadeToRGB(r, g, b)            { this._i2c([0x63, r, g, b]); }

  // 'o' (0x6F) — Stop script
  stopScript()                   { this._i2c([0x6F]); }

  // 'f' (0x66) — Set fade speed (1=slow … 255=instant)
  setFadeSpeed(speed)            { this._i2c([0x66, speed]); }

  // 'p' (0x70) — Play script (id, reps, startPos); reps=0 → loop forever
  playScript(id, reps, pos)      { this._i2c([0x70, id, reps, pos]); }

  // 'L' (0x4C) — Set script length and repeat count
  setScriptLength(id, len, reps) { this._i2c([0x4C, id, len, reps]); }

  // 'B' (0x42) — Set boot parameters (play script on power-up)
  setBootParams(fadeSpeed, reps) { this._i2c([0x42, 1, 0, 0, fadeSpeed, reps]); }

  // 'W' (0x57) — Write script line (script_id=0, line, ticks, cmd='c', r, g, b)
  writeScriptLine(line, ticks, r, g, b) {
    this._i2c([0x57, 0, line, ticks, 0x63, r, g, b]);
  }

  // 'R' (0x52) — Read script line; returns [ticks, cmd, arg1, arg2, arg3]
  // For fadeToRGB lines (cmd=0x63): arg1=r, arg2=g, arg3=b
  readScriptLine(line) {
    return this._i2cRead([0x52, 0, line], 5);
  }
}

module.exports = { LinkM, LINKM_VID, LINKM_PID };
