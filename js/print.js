import {esc, toast, modal, fileName, saveBlob, canShareFile, shareBlob} from './util.js';
import {get} from './store.js';

const hexRgb = h => PDFLib.rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

export async function buildSetPdf(ids, withInk){
  const {PDFDocument, LineCapStyle} = PDFLib;
  const out = await PDFDocument.create();
  out.setTitle('Setlist');
  for(const id of ids){
    const blob = await get('files', id); if(!blob) continue;
    const src = await PDFDocument.load(await blob.arrayBuffer(), {ignoreEncryption:true});
    const pages = await out.copyPages(src, src.getPageIndices());
    for(let i = 0; i < pages.length; i++){
      const pg = out.addPage(pages[i]);
      if(!withInk) continue;
      const strokes = (await get('ink', id + ':' + (i + 1))) || [];
      if(!strokes.length) continue;
      let box; try{ box = pg.getCropBox(); }catch(e){ box = null; }
      if(!box){ const s = pg.getSize(); box = {x:0, y:0, width:s.width, height:s.height}; }
      for(const s of strokes){
        if(!s.p.length) continue;
        const pts = s.p.length === 1 ? [s.p[0], [s.p[0][0] + .0005, s.p[0][1]]] : s.p;
        const path = pts.map((p, j) => (j ? 'L' : 'M') + (p[0] * box.width).toFixed(2) + ' ' + (p[1] * box.height).toFixed(2)).join(' ');
        pg.drawSvgPath(path, {x:box.x, y:box.y + box.height, borderColor:hexRgb(s.c), borderWidth:s.w * box.width,
          borderOpacity:s.t === 'hl' ? .4 : 1, borderLineCap:s.t === 'hl' ? LineCapStyle.Butt : LineCapStyle.Round});
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
