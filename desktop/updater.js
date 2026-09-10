// desktop/updater.js
// Auto-update against GitHub Releases. Disabled in dev and whenever the app is
// not packaged, because unsigned builds cannot install an update on macOS.
const { app } = require('electron');

function initUpdater({ onStatus } = {}) {
  if (!app.isPackaged || process.env.HELIX_DESKTOP_DEV) {
    onStatus?.('disabled (dev)');
    return { checkNow: () => onStatus?.('disabled (dev)') };
  }
  // Lazy require so dev/test never loads the native updater.
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.on('checking-for-update', () => onStatus?.('checking'));
  autoUpdater.on('update-available', () => onStatus?.('downloading'));
  autoUpdater.on('update-not-available', () => onStatus?.('up to date'));
  autoUpdater.on('error', (e) => onStatus?.(`error: ${e.message}`));
  autoUpdater.on('update-downloaded', () => onStatus?.('ready to install'));

  const checkNow = () => autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  setTimeout(checkNow, 8000);
  return { checkNow };
}

module.exports = { initUpdater };
