// Renders the app icons with Playwright Chromium from an inline SVG.
// Usage: node tools/make-icons.mjs   (needs `npm install` + `npx playwright install chromium`)
//
// Outputs (all fully opaque, RGB PNG, no alpha channel):
//   icons/icon-192.png            purpose "any"
//   icons/icon-512.png            purpose "any"
//   icons/icon-maskable-512.png   purpose "maskable" (artwork inside the 80% safe zone)
//   icons/apple-touch-icon.png    180x180
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons');
mkdirSync(outDir, { recursive: true });

const GRAPHITE = '#17181c';
const PAPER = '#f4f1ea';
const RED = '#d93f34';

// 512x512 artwork. The background rect is full-bleed. The paper sheet and everything on it
// sit inside the maskable safe zone (circle of radius 0.4 * 512 = 204.8 around the centre):
// the sheet's half-diagonal is ~192 at scale 1. `scale` enlarges the artwork about the centre
// for the non-maskable icons (kept <= 1.1 so it still clears the edges comfortably).
function svg(scale) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="${GRAPHITE}"/>
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <rect x="136" y="106" width="240" height="300" rx="20" fill="${PAPER}"/>
    <g stroke="${GRAPHITE}" stroke-opacity="0.6" stroke-width="6" stroke-linecap="round">
      <line x1="164" y1="250" x2="348" y2="250"/>
      <line x1="164" y1="296" x2="348" y2="296"/>
      <line x1="164" y1="342" x2="348" y2="342"/>
    </g>
    <line x1="262" y1="300" x2="262" y2="160" stroke="${RED}" stroke-width="10"/>
    <ellipse cx="238" cy="296" rx="30" ry="22" transform="rotate(-20 238 296)" fill="${RED}"/>
  </g>
</svg>`;
}

const icons = [
  { file: 'icon-192.png', size: 192, scale: 1.1 },
  { file: 'icon-512.png', size: 512, scale: 1.1 },
  { file: 'icon-maskable-512.png', size: 512, scale: 1.0 },
  { file: 'apple-touch-icon.png', size: 180, scale: 1.1 },
];

// Minimal PNG writer: 8-bit RGB (color type 2), filter 0, so there is no alpha channel at all.
function encodePngRgb(width, height, rgba) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = y * (stride + 1) + 1 + x * 3;
      raw[d] = rgba[s];
      raw[d + 1] = rgba[s + 1];
      raw[d + 2] = rgba[s + 2];
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const { file, size, scale } of icons) {
    const pixels = await page.evaluate(async ({ markup, size }) => {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, size, size);
      return Array.from(ctx.getImageData(0, 0, size, size).data);
    }, { markup: svg(scale), size });
    const png = encodePngRgb(size, size, Uint8Array.from(pixels));
    writeFileSync(join(outDir, file), png);
    console.log(`wrote icons/${file} (${size}x${size}, ${png.length} bytes)`);
  }
} finally {
  await browser.close();
}
