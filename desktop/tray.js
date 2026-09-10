// desktop/tray.js
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

function createTray({ window }) {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'resources', 'trayTemplate.png'));
  const tray = new Tray(icon);
  let status = 'starting';

  const render = () => {
    tray.setToolTip(`Helix Configurator (${status})`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Backend: ${status}`, enabled: false },
        { type: 'separator' },
        { label: 'Show', click: () => { window.show(); window.focus(); } },
        { label: 'Quit', click: () => app.quit() },
      ])
    );
  };
  render();

  return {
    setStatus: (s) => { status = s; render(); },
    destroy: () => tray.destroy(),
  };
}

module.exports = { createTray };
