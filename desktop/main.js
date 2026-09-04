// desktop/main.js
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const { startBackend } = require('./backend');
const { stateDir } = require('./paths');

let mainWindow = null;
let backend = null;
let quitting = false;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(main);
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(url);
}

async function main() {
  fs.mkdirSync(stateDir(), { recursive: true });
  try {
    backend = await startBackend();
  } catch (err) {
    dialog.showErrorBox('Helix Configurator', `The backend did not start:\n\n${err.message}`);
    app.quit();
    return;
  }

  // In dev, load the Vite dev server (HMR); in prod, load the backend-served UI.
  const devUrl = process.env.HELIX_DESKTOP_DEV ? 'http://127.0.0.1:3000' : backend.baseUrl;
  createWindow(devUrl);

  backend.child.on('exit', (code) => {
    if (quitting) return;
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      buttons: ['Restart backend', 'Quit'],
      defaultId: 0,
      message: 'The Helix Configurator backend stopped unexpectedly.',
      detail: `Exit code: ${code}`,
    });
    if (choice === 0) app.relaunch();
    app.quit();
  });
}

app.on('before-quit', async (e) => {
  if (quitting || !backend) return;
  e.preventDefault();
  quitting = true;
  await backend.stop();
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
