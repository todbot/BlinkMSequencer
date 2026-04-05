// SPDX-FileCopyrightText: Copyright (c) 2026 Tod Kurt / ThingM
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('linkm', {
  // Invocations (renderer → main, returns Promise)
  connect:        ()                  => ipcRenderer.invoke('linkm:connect'),
  disconnect:     ()                  => ipcRenderer.invoke('linkm:disconnect'),
  status:         ()                  => ipcRenderer.invoke('linkm:status'),
  sendColor:      (r, g, b)           => ipcRenderer.invoke('linkm:sendColor', r, g, b),
  preparePreview: (duration)          => ipcRenderer.invoke('linkm:preparePreview', duration),
  burn:           (colors, dur, loop) => ipcRenderer.invoke('linkm:burn', colors, dur, loop),
  download:       ()                  => ipcRenderer.invoke('linkm:download'),
  save:           (data)              => ipcRenderer.invoke('seq:save', data),
  open:           ()                  => ipcRenderer.invoke('seq:open'),

  // Push events (main → renderer)
  onStatus:       (fn) => ipcRenderer.on('linkm:status',       (_, state)    => fn(state)),
  onBurnProgress: (fn) => ipcRenderer.on('linkm:burnProgress', (_, cur, tot) => fn(cur, tot)),

  // App info
  appVersion: () => ipcRenderer.invoke('app:version'),
});
