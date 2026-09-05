// desktop/menu.js
const { Menu, shell, app } = require('electron');
const { stateDir } = require('./paths');

function buildMenu({ window, onRestartBackend }) {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Tools',
      submenu: [
        { label: 'Check for Updates', click: () => global.helixUpdater?.checkNow() },
        { label: 'Open Data Folder', click: () => shell.openPath(stateDir()) },
        { label: 'View Logs', click: () => shell.openPath(app.getPath('logs')) },
        { type: 'separator' },
        { label: 'Restart Backend', click: () => onRestartBackend?.() },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
