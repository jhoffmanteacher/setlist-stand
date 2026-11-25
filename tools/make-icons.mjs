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

// 512x512 artwork (ChartShark, 2026-11-25): a chord chart page (a title, three rows of chord names over lyric
// lines) with a see-through red shark fin rising from the last line. The background rect is full-bleed. The paper
// sheet and everything on it sit inside the maskable safe zone (circle of radius 0.4 * 512 = 204.8 around the
// centre): the sheet's half-diagonal is ~192 at scale 1. `scale` enlarges the artwork about the centre for the
// non-maskable icons (kept <= 1.1 so it still clears the edges comfortably).
// CHORDS is the chord names (G D Em / C G D / Am C) as outlines of vendor/fonts/barlow-600.ttf at 38px, so the
// icons come out the same on any machine, whatever fonts it has.
const CHORDS = 'M164.1 195.3V186.1Q164.1 183.4 165.3 181.4Q166.5 179.3 168.7 178.2Q170.8 177.1 173.7 177.1Q176.5 177.1 178.6 178.2Q180.8 179.3 181.9 181.2Q183.1 183.1 183.1 185.5V185.8Q183.1 186 183 186.1Q182.9 186.3 182.7 186.3H179.2Q179 186.3 178.9 186.1Q178.8 186 178.8 185.8V185.6Q178.8 183.6 177.4 182.2Q176 180.9 173.7 180.9Q171.3 180.9 169.9 182.3Q168.5 183.7 168.5 185.9V195.4Q168.5 197.7 170 199.1Q171.5 200.5 173.9 200.5Q176.1 200.5 177.4 199.3Q178.8 198.1 178.8 196V193.7Q178.8 193.5 178.6 193.5H173.9Q173.7 193.5 173.6 193.3Q173.4 193.2 173.4 193V190.2Q173.4 190 173.6 189.9Q173.7 189.8 173.9 189.8H182.7Q182.9 189.8 183 189.9Q183.1 190 183.1 190.2V195.1Q183.1 199.4 180.6 201.9Q178 204.3 173.7 204.3Q170.8 204.3 168.7 203.2Q166.5 202.1 165.3 200Q164.1 198 164.1 195.3ZM234.8 203.5V177.9Q234.8 177.7 234.9 177.5Q235 177.4 235.2 177.4H244.5Q247.2 177.4 249.3 178.4Q251.3 179.3 252.4 181.1Q253.5 182.8 253.5 185.2V196.2Q253.5 198.6 252.4 200.3Q251.3 202.1 249.3 203.1Q247.2 204 244.5 204H235.2Q235 204 234.9 203.9Q234.8 203.7 234.8 203.5ZM239.4 200.2H244.7Q246.7 200.2 247.9 198.9Q249.1 197.7 249.1 195.5V185.9Q249.1 183.7 247.9 182.5Q246.7 181.2 244.7 181.2H239.4Q239.2 181.2 239.2 181.4V200Q239.2 200.2 239.4 200.2ZM316.3 181.2H303.4Q303.2 181.2 303.2 181.4V188.5Q303.2 188.7 303.4 188.7H312.1Q312.3 188.7 312.4 188.8Q312.5 189 312.5 189.1V192Q312.5 192.2 312.4 192.4Q312.3 192.5 312.1 192.5H303.4Q303.2 192.5 303.2 192.7V200Q303.2 200.2 303.4 200.2H316.3Q316.5 200.2 316.7 200.3Q316.8 200.5 316.8 200.7V203.5Q316.8 203.7 316.7 203.9Q316.5 204 316.3 204H299.2Q299 204 298.9 203.9Q298.8 203.7 298.8 203.5V177.9Q298.8 177.7 298.9 177.5Q299 177.4 299.2 177.4H316.3Q316.5 177.4 316.7 177.5Q316.8 177.7 316.8 177.9V180.7Q316.8 180.9 316.7 181.1Q316.5 181.2 316.3 181.2ZM347.9 191V203.5Q347.9 203.7 347.7 203.9Q347.6 204 347.4 204H344Q343.8 204 343.6 203.9Q343.5 203.7 343.5 203.5V191.9Q343.5 190.1 342.6 189.1Q341.6 188.1 340.1 188.1Q338.5 188.1 337.5 189.1Q336.5 190.1 336.5 191.8V203.5Q336.5 203.7 336.4 203.9Q336.3 204 336.1 204H332.6Q332.4 204 332.3 203.9Q332.2 203.7 332.2 203.5V191.9Q332.2 190.1 331.2 189.1Q330.3 188.1 328.7 188.1Q327.3 188.1 326.3 188.9Q325.4 189.8 325.3 191.2V203.5Q325.3 203.7 325.1 203.9Q325 204 324.8 204H321.3Q321.1 204 321 203.9Q320.9 203.7 320.9 203.5V185Q320.9 184.8 321 184.7Q321.1 184.6 321.3 184.6H324.8Q325 184.6 325.1 184.7Q325.3 184.8 325.3 185V186.3Q325.3 186.4 325.3 186.4Q325.4 186.5 325.5 186.4Q326.3 185.3 327.6 184.8Q328.8 184.3 330.3 184.3Q332.2 184.3 333.6 185Q335 185.8 335.7 187.2Q335.9 187.4 336 187.2Q336.8 185.7 338.3 185Q339.8 184.3 341.6 184.3Q344.6 184.3 346.2 186Q347.9 187.8 347.9 191ZM164.1 269.4V260Q164.1 257.3 165.3 255.3Q166.5 253.3 168.7 252.2Q170.8 251.1 173.7 251.1Q176.5 251.1 178.6 252.2Q180.8 253.2 182 255.2Q183.2 257.1 183.2 259.6Q183.2 259.8 183 260Q182.9 260.1 182.7 260.1L179.2 260.3Q178.8 260.3 178.8 259.9Q178.8 257.6 177.4 256.3Q176 254.9 173.7 254.9Q171.3 254.9 169.9 256.3Q168.5 257.6 168.5 259.9V269.6Q168.5 271.8 169.9 273.1Q171.3 274.5 173.7 274.5Q176 274.5 177.4 273.2Q178.8 271.8 178.8 269.6Q178.8 269.1 179.2 269.1L182.7 269.3Q182.9 269.3 183 269.4Q183.2 269.5 183.2 269.7Q183.2 272.3 182 274.2Q180.8 276.2 178.6 277.2Q176.5 278.3 173.7 278.3Q170.8 278.3 168.7 277.2Q166.5 276.1 165.3 274Q164.1 272 164.1 269.4ZM224.1 269.3V260.1Q224.1 257.4 225.3 255.4Q226.5 253.3 228.7 252.2Q230.8 251.1 233.7 251.1Q236.5 251.1 238.6 252.2Q240.8 253.3 241.9 255.2Q243.1 257.1 243.1 259.5V259.8Q243.1 260 243 260.1Q242.9 260.3 242.7 260.3H239.2Q239 260.3 238.9 260.1Q238.8 260 238.8 259.8V259.6Q238.8 257.6 237.4 256.2Q236 254.9 233.7 254.9Q231.3 254.9 229.9 256.3Q228.5 257.7 228.5 259.9V269.4Q228.5 271.7 230 273.1Q231.5 274.5 233.9 274.5Q236.1 274.5 237.4 273.3Q238.8 272.1 238.8 270V267.7Q238.8 267.5 238.6 267.5H233.9Q233.7 267.5 233.6 267.3Q233.4 267.2 233.4 267V264.2Q233.4 264 233.6 263.9Q233.7 263.8 233.9 263.8H242.7Q242.9 263.8 243 263.9Q243.1 264 243.1 264.2V269.1Q243.1 273.4 240.6 275.9Q238 278.3 233.7 278.3Q230.8 278.3 228.7 277.2Q226.5 276.1 225.3 274Q224.1 272 224.1 269.3ZM298.8 277.5V251.9Q298.8 251.7 298.9 251.5Q299 251.4 299.2 251.4H308.5Q311.2 251.4 313.3 252.4Q315.3 253.3 316.4 255.1Q317.5 256.8 317.5 259.2V270.2Q317.5 272.6 316.4 274.3Q315.3 276.1 313.3 277.1Q311.2 278 308.5 278H299.2Q299 278 298.9 277.9Q298.8 277.7 298.8 277.5ZM303.4 274.2H308.7Q310.7 274.2 311.9 272.9Q313.1 271.7 313.1 269.5V259.9Q313.1 257.7 311.9 256.5Q310.7 255.2 308.7 255.2H303.4Q303.2 255.2 303.2 255.4V274Q303.2 274.2 303.4 274.2ZM180.8 351.6 179.5 347.6Q179.4 347.4 179.3 347.4H169.3Q169.2 347.4 169.1 347.6L167.9 351.6Q167.7 352 167.4 352H163.6Q163.3 352 163.2 351.9Q163.1 351.7 163.2 351.5L171.4 325.8Q171.5 325.4 171.9 325.4H176.7Q177 325.4 177.2 325.8L185.4 351.5Q185.5 351.5 185.5 351.7Q185.5 352 185.1 352H181.3Q180.9 352 180.8 351.6ZM170.4 343.9H178.2Q178.4 343.9 178.3 343.7L174.4 331Q174.3 330.8 174.3 330.8Q174.2 330.8 174.2 331L170.3 343.7Q170.2 343.9 170.4 343.9ZM216 339V351.5Q216 351.7 215.9 351.9Q215.7 352 215.5 352H212.1Q211.9 352 211.8 351.9Q211.6 351.7 211.6 351.5V339.9Q211.6 338.1 210.7 337.1Q209.8 336.1 208.2 336.1Q206.7 336.1 205.7 337.1Q204.7 338.1 204.7 339.8V351.5Q204.7 351.7 204.5 351.9Q204.4 352 204.2 352H200.8Q200.6 352 200.4 351.9Q200.3 351.7 200.3 351.5V339.9Q200.3 338.1 199.4 337.1Q198.4 336.1 196.8 336.1Q195.4 336.1 194.5 336.9Q193.5 337.8 193.4 339.2V351.5Q193.4 351.7 193.3 351.9Q193.1 352 192.9 352H189.4Q189.2 352 189.1 351.9Q189 351.7 189 351.5V333Q189 332.8 189.1 332.7Q189.2 332.6 189.4 332.6H192.9Q193.1 332.6 193.3 332.7Q193.4 332.8 193.4 333V334.3Q193.4 334.4 193.5 334.4Q193.5 334.5 193.6 334.4Q194.5 333.3 195.7 332.8Q196.9 332.3 198.4 332.3Q200.3 332.3 201.7 333Q203.1 333.8 203.9 335.2Q204 335.4 204.1 335.2Q205 333.7 206.5 333Q207.9 332.3 209.8 332.3Q212.7 332.3 214.3 334Q216 335.8 216 339ZM264.1 343.4V334Q264.1 331.3 265.3 329.3Q266.5 327.3 268.6 326.2Q270.8 325.1 273.7 325.1Q276.5 325.1 278.6 326.2Q280.8 327.2 282 329.2Q283.2 331.1 283.2 333.6Q283.2 333.8 283 334Q282.9 334.1 282.7 334.1L279.2 334.3Q278.8 334.3 278.8 333.9Q278.8 331.6 277.4 330.3Q276 328.9 273.7 328.9Q271.3 328.9 269.9 330.3Q268.5 331.6 268.5 333.9V343.6Q268.5 345.8 269.9 347.1Q271.3 348.5 273.7 348.5Q276 348.5 277.4 347.2Q278.8 345.8 278.8 343.6Q278.8 343.1 279.2 343.1L282.7 343.3Q282.9 343.3 283 343.4Q283.2 343.5 283.2 343.7Q283.2 346.3 282 348.2Q280.8 350.2 278.6 351.2Q276.5 352.3 273.7 352.3Q270.8 352.3 268.6 351.2Q266.5 350.1 265.3 348Q264.1 346 264.1 343.4Z';
function svg(scale) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="${GRAPHITE}"/>
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <rect x="136" y="106" width="240" height="300" rx="20" fill="${PAPER}"/>
    <line x1="206" y1="142" x2="306" y2="142" stroke="${GRAPHITE}" stroke-opacity="0.8" stroke-width="12" stroke-linecap="round"/>
    <path d="${CHORDS}" fill="${GRAPHITE}"/>
    <g stroke="${GRAPHITE}" stroke-opacity="0.4" stroke-width="9" stroke-linecap="round">
      <line x1="166" y1="222" x2="214" y2="222"/><line x1="234" y1="222" x2="282" y2="222"/><line x1="300" y1="222" x2="346" y2="222"/>
      <line x1="166" y1="296" x2="206" y2="296"/><line x1="224" y1="296" x2="282" y2="296"/><line x1="300" y1="296" x2="336" y2="296"/>
      <line x1="166" y1="370" x2="244" y2="370"/><line x1="264" y1="370" x2="346" y2="370"/>
    </g>
    <path d="M192 370 C220 324 250 264 304 224 C294 280 308 336 344 370 Z" fill="${RED}" fill-opacity="0.6"/>
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
