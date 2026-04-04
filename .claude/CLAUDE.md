# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BlinkM Sequencer is a Processing (Java) desktop application — a drum machine-like UI for programming BlinkM RGB LED devices from Mac or Windows. Users create color animation sequences on a timeline and upload them to a BlinkM device via serial/I2C through an Arduino.

## Build & Run

This is a **Processing IDE project**. There is no command-line build system.

1. Open `BlinkMSequencer-processing/BlinkMSequencer.pde` in the [Processing IDE](https://processing.org/download)
2. Press **Ctrl+R** (Run) to build and launch the application
3. All `.pde` files in the sketch directory are compiled together as a single program

Dependencies are pre-bundled in `BlinkMSequencer-processing/code/`:
- `blinkm-images.jar` — UI image assets (buttons, icons, labels)
- `RelativeLayout-v1.0.jar` — custom layout manager

## Architecture

### Entry Point & Global State
`BlinkMSequencer.pde` is the Processing sketch entry point (`setup()` / `draw()`). It owns global state: the array of 48 time-slice colors (`sliceColors[]`), duration settings, and references to all top-level components.

### Layer Separation
| Layer | Files |
|---|---|
| Hardware | `BlinkMComm.pde` — serial/I2C commands to BlinkM via Arduino at 19200 baud |
| Data | `TimeLine.pde` — 48 `TimeSlice` objects, each holding a color value |
| UI | `MainFrame.pde`, `TopPanel.pde`, `RightPanel.pde`, `ConnectDialog.pde`, `BurnDialog.pde` |
| Preview | `ColorPreview.pde` — simulates LED fading in real-time |
| Utilities | `Util.pde` (image loading, button factory), `Log.pde` (debug/info/warn/error) |

### Key Data Flow
1. User selects time slices on `TimeLine` → assigns colors via `JColorChooser`
2. `RightPanel` Play button → `TimeLine` drives `ColorPreview` and optionally sends live colors through `BlinkMComm`
3. Upload button → `BlinkMComm.burn()` writes sequence to BlinkM EEPROM via serial, `BurnDialog` shows progress

### Serial Communication
`BlinkMComm` wraps `processing.serial.Serial`. Before preview, it calls `prepareForPreview()`; to upload, `burn()` iterates the 48 slices sending I2C commands. Duration is mapped to BlinkM fade-speed and tick-rate values.

### UI Framework
Swing (`JDialog`, `JPanel`, `JColorChooser`) is used for windowing, embedded inside Processing's `PApplet`. `MetalLookAndFeel` is forced for cross-platform consistency. OS detection adjusts Mac vs. Windows layout differences.

---

## Electron Rewrite (BlinkMSequencerElectron/)

A modern Electron version targeting LinkM USB HID directly — no Arduino/serial dependency. Single track, single BlinkM. The user does git commits manually.

### Build & Run

```
npm run rebuild   # once, to compile node-hid native module
npm start         # run the app
npm run debug     # run with detached DevTools (console focused)
```

### LinkM HID Protocol

Sourced from `~/projects/blinkm/linkM/c_host/linkm-lib.c` and `hiddata.c` — always refer to these files rather than guessing. Key constants:

- VID=`0x20A0`, PID=`0x4110`
- HID Feature Reports: `sendFeatureReport` = SET_FEATURE, `getFeatureReport` = GET_FEATURE
- Report format: `[1, 0xDA, cmd, nsend, nrecv, data...(zero-padded to 17 bytes)]`
  - `buf[0]` = Report ID = 1
  - `buf[1]` = START_BYTE = 0xDA
  - `buf[2]` = command code
  - `buf[3]` = number of bytes to send (I2C addr + payload)
  - `buf[4]` = number of bytes to receive
  - `buf[5..16]` = payload

### BlinkM I2C Commands (default addr 0x09)

| Command | Byte | Args |
|---|---|---|
| fadeToRGB | `0x63` ('c') | r, g, b |
| stopScript | `0x6F` ('o') | — |
| setFadeSpeed | `0x66` ('f') | speed |
| playScript | `0x70` ('p') | id, reps, pos |
| setScriptLength | `0x4C` ('L') | id, len, reps |
| setBootParams | `0x42` ('B') | 1, 0, 0, fadeSpeed, reps |
| writeScriptLine | `0x57` ('W') | 0, line, ticks, 0x63, r, g, b |
| readScriptLine  | `0x52` ('R') | 0, line → response: [ticks, cmd, arg1, arg2, arg3] |

### Duration → BlinkM Timing Map

| Duration (s) | ticks | fadeSpeed |
|---|---|---|
| 3 | 1 | 100 |
| 30 | 18 | 25 |
| 120 | 72 | 5 |

### Known Hardware Constraints

- **EEPROM write cycle**: wait 50ms between `writeScriptLine` calls during burn, and between subsequent burn commands (`setScriptLength`, `setBootParams`, etc.)
- **HID write rate**: sending `fadeToRGB` faster than ~33Hz crashes the LinkM firmware. Rate-limit to MIN_SEND_MS=30 and deduplicate by color in the main process.
- **Playback sendColor**: only send when the playhead crosses a new slice index (not every animation frame). This caps hardware writes to 48 per playback cycle regardless of frame rate.
- **No background polling**: do not poll for device presence. Check only on startup (`linkm:status`) and when the Connect button is pressed.

### File Layout

| File | Role |
|---|---|
| `linkm.js` | `LinkM` class — all HID transport and BlinkM I2C commands; no Electron dependency, reusable |
| `main.js` | Electron main process — IPC handlers, file I/O, window; uses `LinkM` |
| `preload.js` | contextBridge — exposes `window.linkm.*` to renderer |
| `renderer.js` | All UI logic — timeline, playback, color picker, upload/download/open/save |
| `index.html` / `style.css` | UI structure and dark theme |
| `build/` | Build resources: `icon.icns`, `icon.ico`, `entitlements.mac.plist` — do not delete |

### Architecture Notes

- `node-hid` runs in main process only (inside `LinkM`); renderer communicates via contextBridge IPC (`window.linkm.*`)
- Playback uses `requestAnimationFrame` + elapsed time (single source of truth, no drift)
- LED fade preview mirrors `ColorPreview.pde`'s ColorFader: step=25 every 25ms
- "Unset" tile color `rgb(55,55,55)` burns to BlinkM as black (matches original app behavior)
- `reps=0` means loop forever in BlinkM; `reps=1` means play once


### Build Notes:

Before running `npm run dist:mac`, export (in bash):
```
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
```

Before running `npm run dist:win`, export (in Powershell):
```
$env:AZURE_TENANT_ID="..."
$env:AZURE_CLIENT_ID="..."
$env:AZURE_CLIENT_SECRET="..."
```
Azure Trusted Signing config (endpoint, account, profile) is in `package.json` under `build.win.azureSignOptions`.
