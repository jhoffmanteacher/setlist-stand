// Generates small plain-text PDF fixtures into tests/fixtures/.
// Usage: node tools/make-fixtures.mjs
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// vendor/pdf-lib.min.js is a UMD bundle. package.json sets "type":"module", so a plain
// require() would treat the .js file as ESM and break the UMD wrapper. Evaluate it as CJS.
function loadUmd(path) {
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', readFileSync(path, 'utf8'))
    .call(mod.exports, mod, mod.exports, require);
  return mod.exports;
}
const { PDFDocument, StandardFonts, rgb } = loadUmd(join(root, 'vendor', 'pdf-lib.min.js'));

const outDir = join(root, 'tests', 'fixtures');
mkdirSync(outDir, { recursive: true });

const LETTER = [612, 792];

async function makePdf(file, title, pageCount) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = 40;
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage(LETTER);
    const text = `${title} — page ${i}`;
    const width = font.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: Math.max(36, (LETTER[0] - width) / 2),
      y: LETTER[1] / 2,
      size,
      font,
      color: rgb(0, 0, 0),
    });
  }
  const bytes = await doc.save();
  writeFileSync(join(outDir, file), bytes);
  console.log(`wrote tests/fixtures/${file} (${pageCount} page${pageCount === 1 ? '' : 's'}, ${bytes.length} bytes)`);
}

await makePdf('two-page.pdf', 'Fixture Song A', 2);
await makePdf('three-page.pdf', 'Fixture Song B', 3);
await makePdf('one-page.pdf', 'Fixture Song C', 1);
