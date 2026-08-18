'use strict';
/**
 * Secure Gate desktop shell.
 * Shows a connection light, waits until the local VMS (web + Supabase) answers,
 * then loads the login page. Does not embed secrets — the SPA uses its own .env.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const APP_URL = process.env.SECURE_GATE_URL || 'http://127.0.0.1:5173';
const API_URL = process.env.SECURE_GATE_API || 'http://127.0.0.1:54321/auth/v1/health';

function ping(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { signal: ac.signal, cache: 'no-store' })
    .then((r) => { clearTimeout(t); return r.status > 0; })
    .catch(() => { clearTimeout(t); return false; });
}

async function health() {
  const [appUp, apiUp] = await Promise.all([ping(APP_URL, 2500), ping(API_URL, 2500)]);
  return { app: APP_URL, api: API_URL, appUp, apiUp, connected: appUp && apiUp };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    backgroundColor: '#16161A',
    title: 'Secure Gate — Quest Mall',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'splash.html'));

  ipcMain.handle('health', () => health());
  ipcMain.handle('open-app', () => {
    win.loadURL(APP_URL);
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
