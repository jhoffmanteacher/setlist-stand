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

/* A song, artist or version name as it is MADE here: at most 200 characters (what share import and chart update files take), cut at
   a whole character (never half of an emoji) with the trailing space dropped. Anything else is returned as it is. */
export const MAX_NAME = 200;
export const cutName = v => typeof v === 'string' && v.length > MAX_NAME ? v.slice(0, /[\uD800-\uDBFF]/.test(v[MAX_NAME - 1]) ? MAX_NAME - 1 : MAX_NAME).trimEnd() : v;

/* The order of songs in the library, the Archived list, search results and the song pickers: A to Z by song name.
   The song name is what is compared (the `song` field, the title for a record with no `song`), with extra spaces taken
   out and NOTHING else dropped: "The" and "A" are words like any other ("The Weight" is under T). Upper and lower case and
   accents do not matter (sensitivity 'base'), numbers sort as numbers ("2 Fast" before "10 Years Gone"). Songs with the
   same name go by artist, then version, then id (so the order never depends on the order they are stored in).
   It is applied when a list is DRAWN; nothing is written to a song and the stored order is left alone. */
export const sortKey = song => String(song ?? '').replace(/\s+/g, ' ').trim();
const COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const text = v => String(v ?? '');
export function compareSongs(a, b) {
  return COLLATOR.compare(sortKey(a.song || a.title), sortKey(b.song || b.title))
    || COLLATOR.compare(text(a.artist), text(b.artist))
    || COLLATOR.compare(text(a.version), text(b.version))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/* The A to Z strip on the Library (js/azstrip.js) reads the same collator as the sort above, so it can never disagree with the list.
   LETTERS: "#" first (a number or a sign sorts before A), then A to Z. */
export const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
/* The letter a song is listed under: the first character of its song name, compared like the sort (case and accents ignored:
   "Água" is under A, "ébano" under E). Anything that is not A to Z (a digit, a sign, another alphabet) is "#". */
export function songLetter(s) {
  const c = [...sortKey(s.song || s.title)][0] || '';
  return LETTERS.find(L => L !== '#' && COLLATOR.compare(c, L) === 0) || '#';
}
/* The jump target: the first song of a list (already in compareSongs order) whose song name sorts at or after the letter L. A letter
   with no songs gives the next letter's first song; "#" is the top of the list (a name in another alphabet sorts after Z but is
   labelled "#": the strip's "#" still goes to the top, which is the best a 27-button strip can do). */
export function firstAtOrAfter(list, L) {
  if (L === '#') return list[0] || null;
  return list.find(s => COLLATOR.compare(sortKey(s.song || s.title), L) >= 0) || null;
}

/* The search match used by the Library's search box and by the song pickers ("Add songs", "Share songs", "Add songs to a collection"):
   a song (or a picker item) matches when the text typed is somewhere in its title, song, artist or version, case ignored. An empty
   search matches everything. */
export function songMatches(s, q) {
  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return true;
  return [s.title, s.song, s.artist, s.version].map(text).join(' ').toLowerCase().includes(needle);
}
