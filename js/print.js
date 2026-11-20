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

/* One PDF with every song in order, annotations optional. Cropped pages print cropped (the page's CropBox). */
export async function buildSetPdf(ids, withInk){
  const {PDFDocument, LineCapStyle, StandardFonts} = PDFLib;
  const out = await PDFDocument.create();
  out.setTitle('Setlist');
  const font = await out.embedFont(StandardFonts.HelveticaBold);
  /* The built-in PDF font only knows Western letters. Musical signs become their plain look-alikes; anything else it can't draw is dropped. */
  const known = new Set(font.getCharacterSet());
  const printable = str => [...str.replace(/♯/g, '#').replace(/♭/g, 'b').replace(/♮/g, 'n')].filter(ch => known.has(ch.codePointAt(0))).join('');
  for(const id of ids){
    const blob = await get('files', id); if(!blob) continue;
    const song = songById(id);
    const src = await PDFDocument.load(await blob.arrayBuffer(), {ignoreEncryption:true});
    const pages = await out.copyPages(src, src.getPageIndices());
    for(let i = 0; i < pages.length; i++){
      const pg = out.addPage(pages[i]);
      let box; try{ box = pg.getCropBox(); }catch(e){ box = null; }
      if(!box){ const s = pg.getSize(); box = {x:0, y:0, width:s.width, height:s.height}; }
      const strokes = withInk ? liveStrokes(await getInk(id, i + 1)) : [];
      for(const s of strokes){
        if(s.t === 'text'){
          const px = s.size * box.width;
          s.text.split('\n').map(printable).forEach((ln, k) => ln && pg.drawText(ln, {x:box.x + s.x * box.width, y:box.y + box.height - s.y * box.height - px * .85 - k * px * 1.2, size:px, font, color:hexRgb(s.c)}));
          continue;
        }
        if(!s.p.length) continue;
        const pts = s.p.length === 1 ? [s.p[0], [s.p[0][0] + .0005, s.p[0][1]]] : s.p;
        const path = pts.map((p, j) => (j ? 'L' : 'M') + (p[0] * box.width).toFixed(2) + ' ' + (p[1] * box.height).toFixed(2)).join(' ');
        pg.drawSvgPath(path, {x:box.x, y:box.y + box.height, borderColor:hexRgb(s.c), borderWidth:s.w * box.width,
          borderOpacity:s.t === 'hl' ? .4 : 1, borderLineCap:s.t === 'hl' ? LineCapStyle.Butt : LineCapStyle.Round});
      }
      const cr = cropOf(song, i + 1);       // set last: the marks above are placed against the uncropped page
      if(cr){
        const rot = ((pg.getRotation().angle % 360) + 360) % 360;
        const a = toPdf(box, rot, cr.x, cr.y), b = toPdf(box, rot, cr.x + cr.w, cr.y + cr.h);
        pg.setCropBox(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      }
    }
  }
  return out.save();
}

export function printDialog(st, ids){
  const m = modal(`<h2>Print ${esc(st.name)}</h2><p class="hint">Makes one PDF with all ${ids.length} songs in setlist order.</p>
    <label class="opt"><input type="checkbox" id="pInk" checked>Include my annotations</label>
    <div class="btns"><button data-x>Cancel</button><button class="pri" data-ok>Make PDF</button></div>`);
  m.querySelector('[data-x]').onclick = () => m.remove();
  m.querySelector('[data-ok]').onclick = async ev => {
    const withInk = m.querySelector('#pInk').checked; ev.target.disabled = true; ev.target.textContent = 'Working…';
    try{
      const bytes = await buildSetPdf(ids, withInk);
      const blob = new Blob([bytes], {type:'application/pdf'}), name = fileName(st.name) + '.pdf';
      saveBlob(blob, name);
      if(canShareFile(blob, name)){
        m.querySelector('.box').innerHTML = `<h2>PDF saved</h2><p class="hint">${esc(name)} is in your downloads.</p><div class="btns"><button data-share>Share…</button><button class="pri" data-x>Done</button></div>`;
        m.querySelector('[data-x]').onclick = () => m.remove();
        m.querySelector('[data-share]').onclick = () => shareBlob(blob, name);
      } else { m.remove(); toast('PDF saved'); }
    }catch(err){ m.remove(); toast('Could not make the PDF'); }
  };
}
