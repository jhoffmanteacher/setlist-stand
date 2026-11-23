/* Reading an untrusted zip safely: the pieces share import, chart update files and restore all use (the file's own list of files,
   the CRC-32 a zip records for an entry, and an entry read in pieces against a cap). The callers hold the limits. */
export const mb = n => n >= 1e6 ? Math.round(n / 1e6) + ' MB' : Math.round(n / 1e3) + ' KB';

/* The CRC-32 a zip entry records for its bytes. */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for(let n = 0; n < 256; n++){ let c = n; for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = bytes => { let c = 0xFFFFFFFF; for(let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

export const NOT_PACKAGE = 'That file is not a Setlist Stand share package.', TOO_MANY = 'That package has too many files in it.';

/* Why the zip's list of files (its "central directory") cannot be opened safely, as a plain sentence, or null when it is fine.
   JSZip builds heap for every record just to open a zip and has no limit of its own: a small file with a million records costs
   about a gigabyte. So the end-of-directory record must be the last thing in the file (padding after it is never in a real package;
   JSZip searches the whole file backwards, so a guard that only looked at the last 64 KB would miss it), it must not be zip64 (JSZip then reads the 64-bit fields,
   not the 32-bit ones measured here), and the span from where the list starts to where that record sits must be small. A real
   package has none of the first two problems and a list of a few hundred KB. */
export async function directoryProblem(file, maxDirectory){
  const tail = new DataView(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer());
  for(let i = tail.byteLength - 22; i >= 0; i--){
    if(tail.getUint32(i, true) !== 0x06054b50) continue;
    const at = file.size - tail.byteLength + i;
    if(at + 22 + tail.getUint16(i + 20, true) !== file.size) return NOT_PACKAGE;           // bytes after the record
    if([4, 6, 8, 10].some(o => tail.getUint16(i + o, true) === 0xFFFF) || [12, 16].some(o => tail.getUint32(i + o, true) === 0xFFFFFFFF)) return TOO_MANY;   // zip64
    return at - tail.getUint32(i + 16, true) > maxDirectory ? TOO_MANY : null;
  }
  return NOT_PACKAGE;                             // no such record at the end of the file: not a zip
}

/* A zip entry's bytes, read in pieces and counted as they come: resolves to null as soon as they pass `room` bytes (the
   rest is never inflated). Rejects with the zip's own error. */
export function readCapped(entry, room){
  return new Promise((res, rej) => {
    const chunks = []; let n = 0;
    const h = entry.internalStream('uint8array');
    h.on('data', c => { n += c.length; if(n > room){ h.pause(); res(null); } else chunks.push(c); })
      .on('error', rej)
      .on('end', () => { const out = new Uint8Array(n); let o = 0; for(const c of chunks){ out.set(c, o); o += c.length; } res(out); });
    h.resume();
  });
}
