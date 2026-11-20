// Song-name parsing: a faithful port of split_name()/tcase()/display() from
// tools/msb_convert.py. Parity is checked by `node tools/names-parity.mjs <file.msb>`.
// Python semantics replicated: str.strip()/split() whitespace set, re `\s` and `\d`
// (Unicode), `.` (anything but \n), `$` (end, or before a final \n), re.I (Unicode
// case folding), str.isupper(), and code-point lengths/slicing.

const ARTIST_FROM_FILE = new Map([
  ['High And Dry - Chords', 'Radiohead'],
  ['What Goes On - Pro', 'The Beatles'],
]);
const SMALL = new Set(['a', 'an', 'and', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'or', 'by', 'as']);

// Python str.isspace() / re `\s` (str patterns) character set.
const WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const S = `[${WS}]`;           // Python \s
const D = '\\p{Nd}';           // Python \d
const DOT = '[^\\n]';          // Python . (no DOTALL)
const END = '(?=\\n?$)';       // Python $ (no MULTILINE)
const STRIP_RE = new RegExp(`^${S}+|${S}+$`, 'gu');
const SPLIT_RE = new RegExp(`${S}+`, 'u');

const pyStrip = (s) => s.replace(STRIP_RE, '');
const pySplit = (s) => s.split(SPLIT_RE).filter((w) => w !== '');
const cpLen = (s) => [...s].length;

const RE_PDF = new RegExp(`\\.pdf$`, 'giu');
const RE_ONE = new RegExp(`${S}*\\(1\\)${END}`, 'gu');
const RE_SUFFIX = new RegExp(`${S}*-${S}*(Chords|Pro|Lyrics - Chords)(${S}*${D}+)?${END}`, 'gu');
const RE_CHORDS = new RegExp(`${S}+chords${END}`, 'giu');
const RE_VERSION = new RegExp(`^(${DOT}*?)${S}+(OLD|updated|Lyrics|${D}+)${END}`, 'u');
const RE_KEY = new RegExp(`^(${DOT}*?)${S}+(in [A-G](?:${S}+and${S}+[A-G])?)${END}`, 'u');
const RE_DASH_KEY = new RegExp(`^(${DOT}*?)${S}+-${S}+([A-G])${END}`, 'u');

const RE_LOWER = /[\p{Lowercase}\p{Lt}]/u;
const RE_UPPER = /\p{Uppercase}/u;
// Python str.isupper(): at least one cased char, and none lowercase/titlecase.
const pyIsUpper = (w) => RE_UPPER.test(w) && !RE_LOWER.test(w);

function tcase(s) {
  const words = pySplit(s);
  return words.map((w, i) => {
    const lw = w.toLowerCase();
    if (i && i < words.length - 1 && SMALL.has(lw)) return lw;
    if (pyIsUpper(w) && cpLen(w) > 1 && w !== 'OLD') return w;
    const cps = [...w];
    return (cps[0] || '').toUpperCase() + cps.slice(1).join('');
  }).join(' ');
}

export function splitName(raw) {
  let t = pyStrip(String(raw ?? ''));
  t = t.replace(RE_PDF, '');
  let artist = ARTIST_FROM_FILE.get(t) || '';
  t = t.replace(RE_ONE, '');
  t = t.split('Dont ').join("Don't ");
  t = t.replace(RE_SUFFIX, (_, g1, g2) =>
    (g2 ? ' ' + pyStrip(g2) : '') + (g1.startsWith('Lyrics') ? ' Lyrics' : ''));
  t = t.replace(RE_CHORDS, '');
  const parts = t.split(' - ').map(pyStrip);
  if (parts.length === 2 && !artist && cpLen(parts[1]) > 2) {
    [artist, t] = parts;
  } else if (parts.length === 2) {
    t = parts[0] + ' - ' + parts[1];
  }
  let version = '';
  let m = RE_VERSION.exec(t);
  if (m) { t = m[1]; version = m[2].toLowerCase(); }
  m = RE_KEY.exec(t);
  if (m) { t = m[1]; version = m[2]; }
  m = RE_DASH_KEY.exec(t);
  if (m) { t = m[1]; version = 'in ' + m[2]; }
  t = tcase(t);
  if (artist === 'Cat Stevens Yusuf Islam') artist = 'Cat Stevens';
  return { song: t, artist, version };
}

export function displayName({ song = '', artist = '', version = '' } = {}) {
  return song + (version ? ` (${version})` : '') + (artist ? ` - ${artist}` : '');
}

export function sortKey(song) {
  const s = String(song ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const m = /^(the|an|a) (.*)$/s.exec(s);
  return m && m[2].trim() ? m[2] : s;
}
