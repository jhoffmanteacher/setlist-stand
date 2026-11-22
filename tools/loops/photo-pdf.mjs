/*
 * Photo-scan charts made at run time (never stored in the repo: tests/fixtures stays text-only). Each page is ONE big
 * JPEG, like a chart scanned or photographed: about 3000 x 2400 pixels, paper-coloured with grain, a gradient (uneven
 * light) and dark lines of "notes", so it does not compress to nothing (about 0.5 to 1 MB a page, like the scanned
 * charts in a real library). The JPEG is encoded by the browser (canvas.toBlob), then the PDF is built in Node with the
 * vendored pdf-lib. A label is written large on each page and also as invisible PDF text ("<label> page <n>"), so a
 * test can tell with pdf.js's getTextContent which song and page is showing.
 */
import fs from 'node:fs';
import path from 'node:path';
import {PDFDocument} from './harness.mjs';

/* In the page: one noisy JPEG, returned as base64. seed makes each page different. */
const jpegInPage = async ([w, h, seed, label, quality]) => {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#f4efe2'); g.addColorStop(1, '#d9d1bd');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  let s = seed * 9301 + 49297; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  c.fillStyle = '#1b1b1b'; c.strokeStyle = '#222';
  for(let st = 0; st < 9; st++){                                // staves with blobs of "notes"
    const y0 = 260 + st * (h - 400) / 9;
    c.lineWidth = 3; for(let l = 0; l < 5; l++){ c.beginPath(); c.moveTo(120, y0 + l * 22 + rnd() * 3); c.lineTo(w - 120, y0 + l * 22 + rnd() * 3); c.stroke(); }
    for(let n = 0; n < 34; n++){ c.beginPath(); c.ellipse(160 + n * (w - 320) / 34 + rnd() * 20, y0 + rnd() * 88, 14, 10, -.4, 0, 7); c.fill(); }
  }
  c.font = 'bold 120px sans-serif'; c.fillText(label, 140, 170);
  /* grain: every pixel nudged a little, the part that makes a photo heavy */
  const img = c.getImageData(0, 0, w, h), d = img.data;
  for(let i = 0; i < d.length; i += 4){ const v = (rnd() - .5) * 34; d[i] += v; d[i + 1] += v; d[i + 2] += v * 1.1; }
  c.putImageData(img, 0, 0);
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', quality));
  cv.width = cv.height = 0;
  const b = new Uint8Array(await blob.arrayBuffer()); let bin = '';
  for(let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
};

/* Writes dir/<file name>.pdf for each song and returns their paths. page: any Playwright page (its canvas encodes the JPEGs).
   songs: [{file, label}]; pages: pages per song; size: [w, h] of each JPEG in pixels. */
export async function makePhotoPdfs(page, dir, songs, {pages = 2, size = [3000, 2400], quality = 0.72} = {}){
  fs.mkdirSync(dir, {recursive: true});
  const out = [];
  let seed = 1;
  for(const {file, label} of songs){
    const doc = await PDFDocument.create(), font = await doc.embedFont('Helvetica');
    for(let p = 1; p <= pages; p++){
      const b64 = await page.evaluate(jpegInPage, [size[0], size[1], seed++, `${label} ${p}`, quality]);
      const jpg = await doc.embedJpg(Buffer.from(b64, 'base64'));
      const pw = size[0] * 0.24, ph = size[1] * 0.24;            // about 720 x 576 pt: a non-standard page size, like a scan
      const pg = doc.addPage([pw, ph]);
      pg.drawImage(jpg, {x: 0, y: 0, width: pw, height: ph});
      pg.drawText(`${label} page ${p}`, {x: 20, y: 20, size: 10, font, opacity: 0});
    }
    const f = path.join(dir, file + '.pdf');
    fs.writeFileSync(f, await doc.save()); out.push(f);
  }
  return out;
}

/* In the page: gives each song (by title) a crop, as the Crop screen would store it (the same record field, saved). */
export const cropSongs = (page, titles, rect = {x: .06, y: .05, w: .88, h: .9}) => page.evaluate(async ([titles, rect]) => {
  const st = await import('./js/store.js');
  for(const t of titles){
    const s = st.state.songs.find(x => x.title === t);
    if(!s) throw new Error('no song titled ' + t);
    s.crop = {all: {...rect}, pages: {}};
    await st.saveSong(s);
  }
}, [titles, rect]);
