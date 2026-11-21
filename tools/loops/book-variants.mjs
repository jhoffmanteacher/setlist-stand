/*
 * Songbooks for the split loops that point at their own pages in ways other than a Link annotation. Each is the fixture
 * songbook (tests/fixtures/songbook.pdf) plus one trick, made here with pdf-lib so no second PDF is committed.
 * pdf-lib copies everything a page points at, so a pointer on every page would put the whole book into every song.
 *   notes    a sticky note on every page with /P (its page), which Acrobat writes on every comment
 *   widget   one form field shown on every page: every widget has the field as /Parent, and the field lists them all
 *   beads    an article thread whose beads run through every page (/B on the page)
 *   button   a "back to contents" button (a Widget with a GoTo action) instead of a link
 *   private  a note with a private key (/Foo) holding the next page: only dropping every annotation cleans it
 *   pagekey  a private key on every page itself: nothing can clean it, so every song must be refused
 *   onebad   the same key on one page only: that song is refused, the others are still cut
 *   shared   one list of pictures (200 KB each) is the resources of every page; each page draws only its own, but a song
 *            cut from it carries all twelve: the run's space budget must stop it (nothing may be taken out of a page)
 *   mixed    a note on every page, and one extra note with a private key on page 4 (for cutting songs one after another)
 *   junk     damaged /Annots: a number and a stream among the entries, and a number where the array should be
 */
import fs from 'node:fs';
import path from 'node:path';
import {FIX, PDFLib} from './harness.mjs';

const {PDFDocument, PDFName, PDFString, PDFNumber} = PDFLib;
export const KINDS = ['notes', 'widget', 'beads', 'button', 'private', 'pagekey', 'onebad', 'shared'];
const load = () => PDFDocument.load(fs.readFileSync(path.join(FIX, 'songbook.pdf')));

export async function makeVariant(kind){
  const d = await load(), ctx = d.context, pages = d.getPages(), n = pages.length;
  const nextRef = i => pages[(i + 1) % n].ref;
  const addAnnot = (p, ref) => { const have = p.node.Annots(); if(have) have.push(ref); else p.node.set(PDFName.of('Annots'), ctx.obj([ref])); };
  const annot = extra => ctx.register(ctx.obj({Type: 'Annot', Rect: [10, 10, 90, 30], ...extra}));
  if(kind === 'notes') pages.forEach(p => addAnnot(p, annot({Subtype: 'Text', Contents: PDFString.of('a note'), P: p.ref})));
  if(kind === 'widget'){
    const field = ctx.obj({FT: 'Tx', T: PDFString.of('header'), Kids: []}), fref = ctx.register(field);
    pages.forEach(p => { const w = annot({Subtype: 'Widget', Parent: fref, P: p.ref}); field.get(PDFName.of('Kids')).push(w); addAnnot(p, w); });
    d.catalog.set(PDFName.of('AcroForm'), ctx.obj({Fields: [fref]}));
  }
  if(kind === 'beads'){
    const thread = ctx.obj({}), tref = ctx.register(thread);
    const beads = pages.map(p => { const b = ctx.obj({Type: 'Bead', T: tref, P: p.ref, R: [0, 0, 600, 800]}), r = ctx.register(b); p.node.set(PDFName.of('B'), ctx.obj([r])); return [b, r]; });
    beads.forEach(([b], i) => { b.set(PDFName.of('N'), beads[(i + 1) % n][1]); b.set(PDFName.of('V'), beads[(i + n - 1) % n][1]); });
    thread.set(PDFName.of('F'), beads[0][1]);
    d.catalog.set(PDFName.of('Threads'), ctx.obj([tref]));
  }
  if(kind === 'button') pages.forEach(p => addAnnot(p, annot({Subtype: 'Widget', FT: 'Btn', Ff: 65536, A: {S: 'GoTo', D: [pages[0].ref, 'Fit']}})));
  if(kind === 'private') pages.forEach((p, i) => addAnnot(p, annot({Subtype: 'Text', Contents: PDFString.of('a note'), Foo: nextRef(i)})));
  if(kind === 'pagekey') pages.forEach((p, i) => p.node.set(PDFName.of('Foo'), nextRef(i)));
  if(kind === 'onebad') pages[3].node.set(PDFName.of('Foo'), nextRef(3));
  if(kind === 'mixed'){
    pages.forEach(p => addAnnot(p, annot({Subtype: 'Text', Contents: PDFString.of('a note')})));
    addAnnot(pages[3], annot({Subtype: 'Text', Contents: PDFString.of('a note that points on'), Foo: nextRef(3)}));
  }
  if(kind === 'junk'){
    pages[2].node.set(PDFName.of('Annots'), ctx.obj([PDFNumber.of(12), ctx.register(ctx.stream('not an annotation')), annot({Subtype: 'Text', Contents: PDFString.of('a note')})]));
    pages[3].node.set(PDFName.of('Annots'), PDFNumber.of(7));
  }
  if(kind === 'shared'){
    const pad = '% padding\n'.repeat(20000);                       // about 200 KB of comment lines: a valid, big "picture"
    const xo = ctx.obj({});
    pages.forEach((p, i) => xo.set(PDFName.of('Im' + i), ctx.register(ctx.stream(pad, {Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10]}))));
    const font = pages[0].node.Resources().get(PDFName.of('Font'));
    d.catalog.Pages().set(PDFName.of('Resources'), ctx.obj({Font: font, XObject: xo}));
    pages.forEach((p, i) => { p.node.delete(PDFName.of('Resources')); p.node.addContentStream(ctx.register(ctx.stream(`q /Im${i} Do Q`))); });
  }
  return Buffer.from(await d.save());
}

/* A page tree pdf.js and pdf-lib read differently (a /Count that is wrong, or something that is not a page among the kids):
   a song cut by pdf-lib's page k would not be the page k the screen shows. */
export async function damagedTreeBook(how){
  const d = await load(), ctx = d.context, root = d.catalog.Pages();
  if(how === 'count') root.set(PDFName.of('Count'), PDFNumber.of(5));
  else root.Kids().insert(1, ctx.register(ctx.obj({Foo: 1})));
  return Buffer.from(await d.save());
}

/* A book with a layer that is switched off by default (an "answers" layer): a song cut from it would show the layer. */
export async function hiddenLayersBook(how = 'off'){
  const d = await load(), ctx = d.context;
  const ocg = ctx.register(ctx.obj({Type: 'OCG', Name: PDFString.of('Answers')}));
  if(how === 'ocmd') ctx.register(ctx.obj({Type: 'OCMD', OCGs: [ocg], P: 'AllOff'}));      // every layer is on, but a rule hides content
  if(how === 'ocmddirect') d.getPages()[2].node.Resources().set(PDFName.of('Properties'), ctx.obj({MC0: {Type: 'OCMD', OCGs: [ocg], P: 'AllOff'}}));   // the same rule, inline
  d.catalog.set(PDFName.of('OCProperties'), ctx.obj({OCGs: [ocg], D: how === 'off' ? {OFF: [ocg]} : how === 'basestate' ? {BaseState: 'OFF'} : {}}));
  return Buffer.from(await d.save());
}
