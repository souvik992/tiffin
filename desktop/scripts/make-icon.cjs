// Draws the app icon at 512 px with Electron itself, so no image tools are needed.
// quickPOS: the PosiNext mark (orange square, white and navy arrows; ui/src/components/BrandMark.tsx, the sidebar and the favicon).
// Usage: npx electron scripts/make-icon.cjs   -> build/icon.png (electron-builder makes the Windows .ico from it;
// copy it to android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png for the Android app)
// quickPOS Data Manager's icon: ICON_LETTER=D ICON_BG="oklch(35% .06 50)" ICON_OUT=manager-icon.png (npm run icon:manager)
// iPhone/iPad icon: --ios (npm run icon:ios) -> ../ios/TiffinPOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png:
// 1024 px, square and opaque with no alpha channel (iOS rounds the corners itself; the App Store refuses transparency).
const letter = process.env.ICON_LETTER || '', bg = process.env.ICON_BG || 'oklch(66% .2 45)', out = process.env.ICON_OUT || 'icon.png';
const ios = process.env.ICON_IOS === '1' || process.argv.includes('--ios');
const size = ios ? 1024 : 512;
const { app, BrowserWindow, nativeImage } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const zlib = require('node:zlib');

const font = readFileSync(join(__dirname, '..', '..', 'ui', 'src', 'assets', 'fonts', 'fraunces-latin.woff2')).toString('base64');
const box = ios
  ? `inset: 0; border-radius: 0; font: 600 580px/1 F, Georgia, serif; padding-bottom: 44px;`
  : `inset: 16px; border-radius: 112px; font: 600 330px/1 F, Georgia, serif; padding-bottom: 24px;`;
// the PosiNext mark (as in its favicon), filling the box; the box gives the orange and the rounded corners
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" style="width:100%;height:100%;display:block"><g transform="translate(4.48 7.36) scale(0.72)"><path d="M2 2 L12 12 L2 22 H8 L18 12 L8 2 Z" fill="#ffffff"/><path d="M14 2 L24 12 L14 22 H20 L30 12 L20 2 Z" fill="#0a1326"/></g></svg>`;
const markBg = '#f15b00';
const html = `<!doctype html><html><head><style>
@font-face { font-family: F; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 400 700; }
html, body { margin: 0; width: ${size}px; height: ${size}px; background: ${ios ? (letter ? bg : markBg) : 'transparent'}; overflow: hidden; }
div { position: absolute; ${box} background: ${letter ? bg : markBg};${letter ? '' : ' padding: 0;'} color: oklch(99% .01 80);
  display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
</style></head><body><div>${letter || MARK}</div></body></html>`;

/** An RGB PNG (colour type 2, no alpha) from Electron's BGRA bitmap. */
function rgbPng(bgra, w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, d = y * (w * 3 + 1) + 1 + x * 3;
    raw[d] = bgra[s + 2]; raw[d + 1] = bgra[s + 1]; raw[d + 2] = bgra[s];
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: !ios, useContentSize: true, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 500)); // font loaded and painted
  // The iPhone mark is drawn on a canvas at full size: a 1024 px window is taller than many PC screens, and Windows
  // would squeeze it (the capture then comes out stretched).
  const img = ios && !letter
    ? nativeImage.createFromDataURL(await w.webContents.executeJavaScript(`(() => {
        const c = document.createElement('canvas'); c.width = c.height = ${size}; const g = c.getContext('2d');
        g.fillStyle = '${markBg}'; g.fillRect(0, 0, ${size}, ${size});
        g.scale(${size} / 32, ${size} / 32); g.translate(4.48, 7.36); g.scale(0.72, 0.72);
        g.fillStyle = '#ffffff'; g.fill(new Path2D('M2 2 L12 12 L2 22 H8 L18 12 L8 2 Z'));
        g.fillStyle = '#0a1326'; g.fill(new Path2D('M14 2 L24 12 L14 22 H20 L30 12 L20 2 Z'));
        return c.toDataURL('image/png'); })()`))
    : (await w.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).resize({ width: size, height: size });
  if (ios) {
    const file = join(__dirname, '..', '..', 'ios', 'TiffinPOS', 'Assets.xcassets', 'AppIcon.appiconset', 'icon-1024.png');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, rgbPng(img.toBitmap(), size, size));
    console.log(`${file} written`);
  } else {
    mkdirSync(join(__dirname, '..', 'build'), { recursive: true });
    writeFileSync(join(__dirname, '..', 'build', out), img.toPNG());
    console.log(`build/${out} written`);
  }
  app.quit();
});
