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

/* One PDF with every song in order, annotations optional. Cropped pages print cropped (the page's CropBox).
   A password-protected (encrypted) PDF is never copied: pdf-lib cannot decode it and would print blank pages, so
   such songs are left out and returned in `locked` (song ids, each once) for the dialog to name. */
export async function buildSetPdf(ids, withInk){
  const {PDFDocument, LineCapStyle, StandardFonts, degrees} = PDFLib;
  const locked = [];
  const out = await PDFDocument.create();
  out.setTitle('Setlist');
  const font = await out.embedFont(StandardFonts.HelveticaBold);
  /* The built-in PDF font only knows Western letters. Musical signs become their plain look-alikes; anything else it can't draw is dropped. */
  const known = new Set(font.getCharacterSet());
  const printable = str => [...str.replace(/♯/g, '#').replace(/♭/g, 'b').replace(/♮/g, 'n')].filter(ch => known.has(ch.codePointAt(0))).join('');
  for(const id of ids){
    const blob = await get('files', id); if(!blob) continue;
    const song = songById(id);
    /* Detected with isEncrypted, not by catching EncryptedPDFError: pdf-lib's bundled build throws it as a plain Error
       (instanceof and .name do not identify it). ignoreEncryption only lets the check run; the file is not copied. */
    const src = await PDFDocument.load(await blob.arrayBuffer(), {ignoreEncryption:true});
    if(src.isEncrypted){ if(!locked.includes(id)) locked.push(id); continue; }
    const pages = await out.copyPages(src, src.getPageIndices());
    for(let i = 0; i < pages.length; i++){
      const pg = out.addPage(pages[i]);
      let box; try{ box = pg.getCropBox(); }catch(e){ box = null; }
      if(!box){ const s = pg.getSize(); box = {x:0, y:0, width:s.width, height:s.height}; }
      const rot = ((pg.getRotation().angle % 360) + 360) % 360;
      /* Marks are stored as fractions of the page AS DISPLAYED (rotation applied), so every point goes through toPdf. */
      const dispW = rot % 180 ? box.height : box.width, dispH = rot % 180 ? box.width : box.height;
      const strokes = withInk ? liveStrokes(await getInk(id, i + 1)) : [];
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
      const cr = cropOf(song, i + 1);       // set last: the marks above are placed against the uncropped page
      if(cr){
        const a = toPdf(box, rot, cr.x, cr.y), b = toPdf(box, rot, cr.x + cr.w, cr.y + cr.h);
        pg.setCropBox(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      }
    }
  }
  return {bytes:out.getPageCount() ? await out.save() : null, locked};
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
  /* Password-protected songs: say which, and print the rest only when asked (never blank pages without a word). */
  const askLocked = (bytes, locked) => {
    const titles = [...new Set(locked.map(id => songById(id)?.title || 'A song'))];
    box.innerHTML = `<h2 id="printLocked">${titles.length === 1 ? 'One song' : titles.length + ' songs'} can't be printed</h2>
      <ul class="locked">${titles.map(t => `<li>${esc(t)} is password-protected, so it can't be printed; it still plays on the screen.</li>`).join('')}</ul>
      <div class="btns"><button data-x>Cancel</button>${bytes ? '<button class="pri" data-ok>Print without them</button>' : ''}</div>`;
    box.setAttribute('aria-labelledby', 'printLocked');
    m.querySelector('[data-x]').onclick = () => m.remove();
    if(bytes) m.querySelector('[data-ok]').onclick = () => save(bytes);
    box.focus();
  };
  m.querySelector('[data-x]').onclick = () => m.remove();
  m.querySelector('[data-ok]').onclick = async ev => {
    const withInk = m.querySelector('#pInk').checked; ev.target.disabled = true; ev.target.textContent = 'Working…';
    try{
      const {bytes, locked} = await buildSetPdf(ids, withInk);
      if(!m.isConnected) return;            // cancelled while it was working
      if(locked.length) askLocked(bytes, locked);
      else if(bytes) save(bytes);
      else { m.remove(); toast('Could not make the PDF'); }
    }catch(err){ m.remove(); toast('Could not make the PDF'); }
  };
}
