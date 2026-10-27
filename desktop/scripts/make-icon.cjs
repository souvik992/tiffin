// Draws the app icon (the "T" mark from the sidebar) at 512 px with Electron itself, so no image tools are needed.
// Usage: npx electron scripts/make-icon.cjs   -> build/icon.png (electron-builder makes the Windows .ico from it)
// Tiffin Data Manager's icon: ICON_LETTER=D ICON_BG="oklch(35% .06 50)" ICON_OUT=manager-icon.png (npm run icon:manager)
const letter = process.env.ICON_LETTER || 'T', bg = process.env.ICON_BG || 'oklch(66% .2 45)', out = process.env.ICON_OUT || 'icon.png';
const { app, BrowserWindow } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const font = readFileSync(join(__dirname, '..', '..', 'ui', 'src', 'assets', 'fonts', 'fraunces-latin.woff2')).toString('base64');
const html = `<!doctype html><html><head><style>
@font-face { font-family: F; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 400 700; }
html, body { margin: 0; width: 512px; height: 512px; background: transparent; overflow: hidden; }
div { position: absolute; inset: 16px; border-radius: 112px; background: ${bg}; color: oklch(99% .01 80);
  display: flex; align-items: center; justify-content: center; font: 600 330px/1 F, Georgia, serif; padding-bottom: 24px; box-sizing: border-box; }
</style></head><body><div>${letter}</div></body></html>`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 500)); // font loaded and painted
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  mkdirSync(join(__dirname, '..', 'build'), { recursive: true });
  writeFileSync(join(__dirname, '..', 'build', out), img.resize({ width: 512, height: 512 }).toPNG());
  console.log(`build/${out} written`);
  app.quit();
});
