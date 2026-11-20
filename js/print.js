import {esc, toast, modal, fileName, saveBlob, canShareFile, shareBlob} from './util.js';
import {get, getInk, liveStrokes, songById, cropOf} from './store.js';

const hexRgb = h => PDFLib.rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

/* Where a point of the displayed page (u, v as fractions, origin top-left) sits in the PDF's own coordinates. */
function toPdf(box, rot, u, v){
  const {x, y, width:W, height:H} = box;
  if(rot === 90) return [x + v * W, y + u * H];
  if(rot === 180) return [x + (1 - u) * W, y + v * H];
  if(rot === 270) return [x + (1 - v) * W, y + (1 - u) * H];
  return [x + u * W, y + (1 - v) * H];
}

/* Only finite numbers reach pdf-lib: one NaN or Infinity in a path makes it throw and the whole print fails. */
const finitePt = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/* Protected pages print as pictures: rendered by pdf.js with the long side this many pixels (about 200 dpi for
   Letter), saved as JPEG at this quality. */
const PIC_PX = 2200, PIC_Q = .9;

/* Opens PDF bytes with pdf.js (util.js has already made getDocument use isEvalSupported:false).
   Returns the document, or {why:'password'} when it needs a real password to open at all, or {why:'broken'}. */
async function openWithPdfjs(buf){
  const task = pdfjsLib.getDocument({data:new Uint8Array(buf)});
  try{ return await task.promise; }
  catch(e){ try{ task.destroy(); }catch(e2){} return {why:e && e.name === 'PasswordException' ? 'password' : 'broken'}; }
}

/* Page pn of a pdf.js document as a JPEG embedded in `out`, sized in points like the page as displayed (rotation
   applied, so the new page needs no /Rotate). Only one canvas exists at a time, and it is emptied before returning. */
async function pictureOf(doc, pn, out){
  const p = await doc.getPage(pn);
  const v1 = p.getViewport({scale:1});
  const vp = p.getViewport({scale:PIC_PX / Math.max(v1.width, v1.height)});
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(vp.width)); cv.height = Math.max(1, Math.round(vp.height));
  try{
    const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
    await p.render({canvasContext:c, viewport:vp}).promise;
    const jpg = await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('JPEG failed')), 'image/jpeg', PIC_Q));
    return {img:await out.embedJpg(await jpg.arrayBuffer()), w:v1.width, h:v1.height};
  } finally { cv.width = cv.height = 0; p.cleanup(); }
}

/* One PDF with every song in order, annotations optional. Cropped pages print cropped (the page's CropBox).
   A protected (encrypted) PDF is never copied: pdf-lib cannot decode it and would print blank pages. Without
   opts.pictures such songs are left out and returned in `locked` (song ids, each once); with it, pdf.js renders their
   pages and they print as pictures, marks and crop placed exactly as on copied pages. A file pdf.js cannot open
   either (it needs a real password, or is damaged) is always left out and returned in `left` ({id, why}, each once).
   opts.progress(done, total) is told after each picture page; opts.cancelled() stops early (bytes null). */
export async function buildSetPdf(ids, withInk, opts = {}){
  const {PDFDocument, LineCapStyle, StandardFonts, degrees} = PDFLib;
  const locked = [], left = [], seen = new Map();    // seen: id -> {pics} | {pages} | {why}, for encrypted songs
  let lockedPages = 0, done = 0;
  const out = await PDFDocument.create();
  out.setTitle('Setlist');
  const font = await out.embedFont(StandardFonts.HelveticaBold);
  /* The built-in PDF font only knows Western letters. Musical signs become their plain look-alikes; anything else it can't draw is dropped. */
  const known = new Set(font.getCharacterSet());
  const printable = str => [...str.replace(/♯/g, '#').replace(/♭/g, 'b').replace(/♮/g, 'n')].filter(ch => known.has(ch.codePointAt(0))).join('');
  /* Annotations, then the crop, of one output page. box and rot describe the page as pdf-lib sees it. */
  const markPage = async (pg, box, rot, id, song, pn) => {
    /* Marks are stored as fractions of the page AS DISPLAYED (rotation applied), so every point goes through toPdf. */
    const dispW = rot % 180 ? box.height : box.width, dispH = rot % 180 ? box.width : box.height;
    const strokes = withInk ? liveStrokes(await getInk(id, pn)) : [];
    for(const s of strokes){
      if(s.t === 'text'){
        if(!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.size) || typeof s.text !== 'string') continue;
        const px = s.size * dispW;
        s.text.split('\n').map(printable).forEach((ln, k) => {
          if(!ln) return;
          const [x, y] = toPdf(box, rot, s.x, s.y + (.85 + 1.2 * k) * px / dispH);   // the baseline of line k
          pg.drawText(ln, {x, y, size:px, font, color:hexRgb(s.c), rotate:degrees(rot)});
        });
        continue;
      }
      const ok = Array.isArray(s.p) ? s.p.filter(finitePt) : [];
      if(!ok.length || !Number.isFinite(s.w)) continue;
      const pts = ok.length === 1 ? [ok[0], [ok[0][0] + .0005, ok[0][1]]] : ok;
      /* drawSvgPath flips y, so the path is written with -Y to land on PDF coordinates (X, Y) */
      const path = pts.map((p, j) => { const [X, Y] = toPdf(box, rot, p[0], p[1]); return (j ? 'L' : 'M') + X.toFixed(2) + ' ' + (-Y).toFixed(2); }).join(' ');
      pg.drawSvgPath(path, {x:0, y:0, borderColor:hexRgb(s.c), borderWidth:s.w * dispW,
        borderOpacity:s.t === 'hl' ? .4 : 1, borderLineCap:s.t === 'hl' ? LineCapStyle.Butt : LineCapStyle.Round});
    }
    const cr = cropOf(song, pn);       // set last: the marks above are placed against the uncropped page
    if(cr){
      const a = toPdf(box, rot, cr.x, cr.y), b = toPdf(box, rot, cr.x + cr.w, cr.y + cr.h);
      pg.setCropBox(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    }
  };
  /* An encrypted song: open it with pdf.js once; render its pages (pictures) or just count them (first look). */
  const protectedSong = async (id, blob) => {
    if(seen.has(id)) return seen.get(id);
    let r;
    const doc = await openWithPdfjs(await blob.arrayBuffer());
    if(doc.why) r = {why:doc.why};
    else try{
      if(!opts.pictures) r = {pages:doc.numPages};
      else {
        const pics = [];
        for(let pn = 1; pn <= doc.numPages; pn++){
          if(opts.cancelled && opts.cancelled()) return null;
          pics.push(await pictureOf(doc, pn, out));
          if(opts.progress) opts.progress(++done, opts.total || doc.numPages);
        }
        r = {pics};
      }
    } finally { doc.destroy(); }
    if(r.why) left.push({id, why:r.why}); else { locked.push(id); lockedPages += r.pics ? r.pics.length : r.pages; }
    seen.set(id, r);
    return r;
  };
  for(const id of ids){
    if(opts.cancelled && opts.cancelled()) return {bytes:null, locked, left, lockedPages, cancelled:true};
    const blob = await get('files', id); if(!blob) continue;
    const song = songById(id);
    /* Detected with isEncrypted, not by catching EncryptedPDFError: pdf-lib's bundled build throws it as a plain Error
       (instanceof and .name do not identify it). ignoreEncryption only lets the check run; the file is not copied. */
    const src = await PDFDocument.load(await blob.arrayBuffer(), {ignoreEncryption:true});
    if(src.isEncrypted){
      const r = await protectedSong(id, blob);
      if(!r) return {bytes:null, locked, left, lockedPages, cancelled:true};
      /* a picture page is new output: page size = the pdf.js page at scale 1, no /Rotate, so marks map with rot 0 */
      if(r.pics) for(const [i, pic] of r.pics.entries()){
        const pg = out.addPage([pic.w, pic.h]);
        pg.drawImage(pic.img, {x:0, y:0, width:pic.w, height:pic.h});
        await markPage(pg, {x:0, y:0, width:pic.w, height:pic.h}, 0, id, song, i + 1);
      }
      continue;
    }
    const pages = await out.copyPages(src, src.getPageIndices());
    for(let i = 0; i < pages.length; i++){
      const pg = out.addPage(pages[i]);
      let box; try{ box = pg.getCropBox(); }catch(e){ box = null; }
      if(!box){ const s = pg.getSize(); box = {x:0, y:0, width:s.width, height:s.height}; }
      const rot = ((pg.getRotation().angle % 360) + 360) % 360;
      await markPage(pg, box, rot, id, song, i + 1);
    }
  }
  return {bytes:out.getPageCount() ? await out.save() : null, locked, left, lockedPages};
}

export function printDialog(st, ids){
  const m = modal(`<h2>Print ${esc(st.name)}</h2><p class="hint">Makes one PDF with all ${ids.length} songs in setlist order.</p>
    <label class="opt"><input type="checkbox" id="pInk" checked>Include my annotations</label>
    <div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Make PDF</button></div>`);
  const box = m.querySelector('.box');
  const name = fileName(st.name) + '.pdf';
  const save = bytes => {
    const blob = new Blob([bytes], {type:'application/pdf'});
    saveBlob(blob, name);
    if(canShareFile(blob, name)){
      box.innerHTML = `<h2 id="printDone">PDF saved</h2><p class="hint">${esc(name)} is in your downloads.</p><div class="btns"><button data-share>Share…</button><button class="pri" data-x>Done</button></div>`;
      box.setAttribute('aria-labelledby', 'printDone');
      m.querySelector('[data-x]').onclick = () => m.remove();
      m.querySelector('[data-share]').onclick = () => shareBlob(blob, name);
      box.focus();
    } else { m.remove(); toast('PDF saved'); }
  };
  const titleOf = id => songById(id)?.title || 'A song';
  const WHY = {password:'needs a password, so it can\'t be printed.', broken:'could not be read, so it can\'t be printed.'};
  /* Protected songs: say which, and offer to print them as pictures, or the rest without them (never blank pages
     without a word). Songs pdf.js cannot open at all are named on their own lines and always left out. */
  const askLocked = (bytes, locked, left, lockedPages, withInk) => {
    const pics = [...new Set(locked.map(titleOf))];
    const head = pics.length ? (pics.length === 1 ? 'One chart is protected' : pics.length + ' charts are protected')
      : (left.length === 1 ? 'One song' : left.length + ' songs') + ' can\'t be printed';
    box.innerHTML = `<h2 id="printLocked">${head}</h2>
      ${pics.length ? `<ul class="locked">${pics.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      <p class="hint">These charts are protected, so they print as pictures: the text will not be selectable and the file is larger.</p>` : ''}
      ${left.length ? `<ul class="locked left">${left.map(x => `<li>${esc(titleOf(x.id))} ${WHY[x.why] || WHY.broken}</li>`).join('')}</ul>` : ''}
      <div class="btns"><button data-x>Cancel</button>${bytes ? `<button ${pics.length ? '' : 'class="pri" '}data-without>Print without them</button>` : ''}${pics.length ? '<button class="pri" data-pics>Print them as pictures</button>' : ''}</div>`;
    box.setAttribute('aria-labelledby', 'printLocked');
    m.querySelector('[data-x]').onclick = () => m.remove();
    if(bytes) m.querySelector('[data-without]').onclick = () => save(bytes);
    if(pics.length) m.querySelector('[data-pics]').onclick = () => asPictures(lockedPages, withInk);
    box.focus();
  };
  const asPictures = async (total, withInk) => {
    const status = n => `Preparing protected pages: ${n} of ${total}`;
    box.innerHTML = `<h2 id="printWork">Making PDF</h2><p class="hint" id="pStatus" role="status">${status(0)}</p><div class="btns"><button data-x>Cancel</button></div>`;
    box.setAttribute('aria-labelledby', 'printWork');
    m.querySelector('[data-x]').onclick = () => m.remove();
    const line = m.querySelector('#pStatus');
    try{
      const {bytes} = await buildSetPdf(ids, withInk, {pictures:true, total, progress:n => { line.textContent = status(n); }, cancelled:() => !m.isConnected});
      if(!m.isConnected) return;            // cancelled while it was working
      if(bytes) save(bytes); else { m.remove(); toast('Could not make the PDF'); }
    }catch(err){ m.remove(); toast('Could not make the PDF'); }
  };
  m.querySelector('[data-x]').onclick = () => m.remove();
  m.querySelector('[data-ok]').onclick = async ev => {
    const withInk = m.querySelector('#pInk').checked; ev.target.disabled = true; ev.target.textContent = 'Working…';
    try{
      const {bytes, locked, left, lockedPages} = await buildSetPdf(ids, withInk);
      if(!m.isConnected) return;            // cancelled while it was working
      if(locked.length || left.length) askLocked(bytes, locked, left, lockedPages, withInk);
      else if(bytes) save(bytes);
      else { m.remove(); toast('Could not make the PDF'); }
    }catch(err){ m.remove(); toast('Could not make the PDF'); }
  };
}
