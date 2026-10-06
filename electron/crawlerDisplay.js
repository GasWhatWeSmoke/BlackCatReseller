const fs = require('node:fs');
const path = require('node:path');

function crawlerDisplay(displays, primaryId) {
  const usable = displays.filter(display => {
    const area = display.workArea;
    return area && [area.x, area.y, area.width, area.height].every(Number.isInteger) && area.width >= 640 && area.height >= 480;
  });
  const display = usable.find(value => value.id !== primaryId);
  if (!display) return { version: 1, secondary: false, bounds: null, reason: 'Connect the second monitor to open Black Cat webpages' };
  const area = display.workArea;
  const width = Math.min(area.width, 1600), height = Math.min(area.height, 1000);
  return { version: 1, secondary: display.id !== primaryId, displayId: String(display.id),
    bounds: { left: area.x + Math.floor((area.width - width) / 2), top: area.y + Math.floor((area.height - height) / 2), width, height } };
}

function watchCrawlerDisplay(screen, dataRoot, log = () => {}) {
  const refresh = () => {
    try {
      const value = crawlerDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay().id);
      const file = path.join(dataRoot, 'crawler-display.json');
      fs.mkdirSync(dataRoot, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(value));
      fs.renameSync(file + '.tmp', file);
    } catch (error) {
      // A stale secondary rectangle may now belong to the primary screen.
      try { fs.writeFileSync(path.join(dataRoot, 'crawler-display.json'), JSON.stringify({ version: 1, secondary: false, bounds: null })); } catch {}
      log(`Marketplace display could not be updated: ${error.message}`);
    }
  };
  refresh();
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, refresh);
}

module.exports = { crawlerDisplay, watchCrawlerDisplay };
