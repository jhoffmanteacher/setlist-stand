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
const { PDFDocument, StandardFonts, rgb, PDFName, PDFHexString, PDFNumber, degrees } = loadUmd(join(root, 'vendor', 'pdf-lib.min.js'));

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

// A text-only "songbook" for the split-import tests: 12 pages, no music. Bookmarks (nested, one by named
// destination), page 4 rotated 90 degrees, two songs sharing page 7, and hyperlinks between pages (page 12 links to
// the songs, every other page links back to page 12). The links are there on purpose: pdf-lib follows them when it
// copies a page, so a split that did not drop them would drag the whole book into every song.
async function makeSongbook(file) {
  const doc = await PDFDocument.create();
  doc.setTitle('Fixture Songbook');
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx = doc.context;
  const starts = { 1: 'Song One', 3: 'Song Two', 4: 'Song Three', 7: 'Song Four and Song Five', 10: 'Song Six', 12: 'Index' };
  const pages = [];
  for (let i = 1; i <= 12; i++) {
    const page = doc.addPage(LETTER);
    page.drawText(`Songbook Fixture page ${i}`, { x: 60, y: 700, size: 30, font, color: rgb(0, 0, 0) });
    if (starts[i]) page.drawText(starts[i], { x: 60, y: 600, size: 44, font, color: rgb(0, 0, 0) });
    pages.push(page);
  }
  pages[3].setRotation(degrees(90));
  const refs = pages.map((p) => p.ref);
  const link = (page, toPage, y) => {
    const ref = ctx.register(ctx.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [60, y, 300, y + 24], Border: [0, 0, 0],
      Dest: [refs[toPage - 1], PDFName.of('Fit')],
    }));
    const have = page.node.Annots();
    if (have) have.push(ref); else page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
  };
  for (let i = 1; i <= 11; i++) link(pages[i - 1], 12, 40);
  [1, 3, 4, 7, 10].forEach((to, k) => link(pages[11], to, 500 - 40 * k));
  // bookmarks
  const tree = [
    { title: 'Part One', page: 1, items: [{ title: 'Song One', page: 1 }, { title: 'Song Two - Fixture Artist', page: 3 }, { title: 'Song Three (in G)', page: 4 }] },
    { title: 'Part Two', page: 7, items: [{ title: 'Song Four', page: 7 }, { title: 'Song Five', page: 7 }, { title: 'Song Six', page: 10, named: 'songsix' }] },
    { title: 'Index', page: 12 },
  ];
  let total = 0;
  const build = (items, parentRef) => {
    const rs = items.map(() => ctx.nextRef());
    items.forEach((it, i) => {
      total++;
      const dest = it.named ? PDFName.of(it.named) : ctx.obj([refs[it.page - 1], PDFName.of('Fit')]);
      const d = ctx.obj({ Title: PDFHexString.fromText(it.title), Parent: parentRef, Dest: dest });
      if (i > 0) d.set(PDFName.of('Prev'), rs[i - 1]);
      if (i < items.length - 1) d.set(PDFName.of('Next'), rs[i + 1]);
      if (it.items) {
        const kids = build(it.items, rs[i]);
        d.set(PDFName.of('First'), kids[0]); d.set(PDFName.of('Last'), kids[kids.length - 1]); d.set(PDFName.of('Count'), PDFNumber.of(kids.length));
      }
      ctx.assign(rs[i], d);
    });
    return rs;
  };
  const rootRef = ctx.nextRef();
  const top = build(tree, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top[0], Last: top[top.length - 1], Count: total }));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  doc.catalog.set(PDFName.of('Dests'), ctx.obj({ songsix: [refs[9], PDFName.of('Fit')] }));
  const bytes = await doc.save();
  writeFileSync(join(outDir, file), bytes);
  console.log(`wrote tests/fixtures/${file} (12 pages, bookmarks, links, ${bytes.length} bytes)`);
}
await makeSongbook('songbook.pdf');
