/* One song's PDF, cut out of a songbook. */

/* A song that cannot be cut cleanly is refused (error.cut) and never saved. */
const cutError = why => Object.assign(new Error(why), {cut:true});

/* pdf-lib copies everything a page points at, and a page can point at other pages in many ways: a link's destination, an
   annotation's /P (its page: Acrobat writes it on every note), a form field's /Kids (one field shown on every page lists
   them all), a button's action, an article thread's beads. One such pointer on every page puts the whole book into every
   song. So, on the in-memory copy of the book (never the file on the tablet): links are dropped, the other annotations
   stay but lose the keys that point away, and the page loses its article beads and actions. A damaged /Annots (a number
   where a dictionary should be) is dropped entry by entry instead of stopping the cut. */
const AWAY = ['P', 'A', 'AA', 'Dest', 'IRT'], PAGE_AWAY = ['B', 'AA', 'SeparationInfo'];
function cleanPage(page, allAnnots){
  const {PDFDict, PDFArray, PDFName} = PDFLib, node = page.node, ctx = node.context, key = k => PDFName.of(k);
  for(const k of PAGE_AWAY) node.delete(key(k));
  const raw = ctx.lookup(node.get(key('Annots')));
  if(raw === undefined) return;
  /* the value is replaced where it is (never deleted and added again): that would move the key to the end of the page
     dictionary, and the same pages would then give different bytes depending on what was cut before */
  if(allAnnots || !(raw instanceof PDFArray)){ node.set(key('Annots'), ctx.obj([])); return; }
  for(let j = raw.size() - 1; j >= 0; j--){
    const o = raw.lookup(j), a = o instanceof PDFDict ? o : null, sub = a && a.get(key('Subtype')), name = sub ? sub.toString() : '';
    if(!a || name === '/Link'){ raw.remove(j); continue; }
    for(const k of AWAY) a.delete(key(k));
    if(name === '/Widget') a.delete(key('Parent'));          // a form field's parent lists every page's widget
    const pop = ctx.lookup(a.get(key('Popup')));             // a popup that is not listed on the page still has its own /P
    if(pop instanceof PDFDict) pop.delete(key('P'));
  }
}

/* Some books make every song as heavy as the whole book (one list of every picture for all pages, a shared appearance
   stream...): a 100 MB book cut into 100 songs would write 10 GB. Nothing is taken out of a page to fix that (a song must
   never lose part of a chart). Instead a run has a space budget: the songs it writes may add up to the larger of `floor`
   bytes and `factor` times the book. A song that would not fit stops the run (error.space). The weight of a song is the
   size of its streams, known before save() (which needs as much memory again). `limits` can be changed by the tests. */
export const limits = {floor:150e6, factor:3};
export const budgetFor = bookBytes => Math.max(limits.floor, limits.factor * bookBytes);
function weightOf(doc){
  const {PDFRawStream} = PDFLib; let n = 0;
  for(const [, o] of doc.context.enumerateIndirectObjects()) if(o instanceof PDFRawStream) n += o.contents.length;
  return n;
}

/* How many page objects a document holds (a song must hold exactly its own pages). */
function pageObjects(doc){
  const {PDFDict, PDFName} = PDFLib; let n = 0;
  for(const [, o] of doc.context.enumerateIndirectObjects()) if(o instanceof PDFDict && String(o.get(PDFName.of('Type'))) === '/Page') n++;
  return n;
}

/* Pages `from` to `to` (1-based, both included) of `src`, an opened pdf-lib document, as a new PDF: {bytes, pages}.
   Page size, rotation and boxes come across as they are. No dates are written, so the same pages always give the
   same bytes (and so the same hash: a book split twice is spotted as duplicates).
   The song is checked after it is made: if it holds any page of the book besides its own (some pointer cleanPage does not
   know), every annotation is dropped and it is made again; if it still does, it is refused (error.cut) and never saved.
   `room` is how many bytes the run may still write: a song heavier than that throws error.space before it is saved.
   The retry takes the notes off the song only: the book keeps them for the next song that shares a page. */
export async function makeSongPdf(src, from, to, room = Infinity){
  const {PDFName} = PDFLib, idx = [], key = PDFName.of('Annots');
  for(let i = from - 1; i <= to - 1; i++) idx.push(i);
  for(const allAnnots of [false, true]){
    const own = idx.map(i => src.getPage(i).node.get(key));
    for(const i of idx) cleanPage(src.getPage(i), allAnnots);
    const out = await PDFLib.PDFDocument.create({updateMetadata:false});
    for(const p of await out.copyPages(src, idx)){
      const a = out.context.lookup(p.node.get(key));
      if(a && a.size && a.size() === 0) p.node.delete(key);      // no empty /Annots left behind by the dropped links
      out.addPage(p);
    }
    if(allAnnots) idx.forEach((i, k) => { if(own[k]) src.getPage(i).node.set(key, own[k]); });
    if(pageObjects(out) !== idx.length) continue;
    if(weightOf(out) > room) throw Object.assign(new Error('The songs would take more space than the run may use'), {space:true});
    return {bytes:await out.save(), pages:out.getPageCount()};
  }
  throw cutError('The pages of this song point at other pages of the book');
}

/* True when the book tags content with a layer rule (an optional-content membership: "visible only if these are all off"...).
   Its effect depends on the book's layer settings, which a song does not carry: such a book is refused. */
export function usesLayerRules(lib){
  const {PDFDict, PDFArray, PDFName} = PDFLib, type = PDFName.of('Type');
  /* an OCMD can be an object of its own or sit inline (in /Properties, in an image's /OC): look through every dictionary */
  const seek = (o, depth) => {
    const d = o && o.dict instanceof PDFDict ? o.dict : o;
    if(depth > 200) return false;
    if(d instanceof PDFDict){
      if(String(d.get(type)) === '/OCMD') return true;
      for(const [, v] of d.entries()) if((v instanceof PDFDict || v instanceof PDFArray) && seek(v, depth + 1)) return true;
    } else if(d instanceof PDFArray){
      for(let i = 0; i < d.size(); i++){ const v = d.get(i); if((v instanceof PDFDict || v instanceof PDFArray) && seek(v, depth + 1)) return true; }
    }
    return false;
  };
  for(const [, o] of lib.context.enumerateIndirectObjects()) if(seek(o, 0)) return true;
  return false;
}
