/* Turns a PDF file name into {song, artist, version}.
   Convention (title first):  "Song Title (version) - Artist.pdf"   e.g. "War Pigs - Black Sabbath.pdf", "Flowers in the Ashes (in G).pdf"
   Old MobileSheets-style names ("Artist - Title - Chords", "Title OLD", "Title in G") still go through splitName(). */
import {splitName} from './names.js';

/* A trailing " (1)" alone is NOT a sign of an old name: browsers add " (1)", " (2)" to a file downloaded twice.
   It only counts after an old "- Chords" style suffix ("Artist - Title - Chords (1)"), or on a name with no " - " at all. */
const LEGACY = /\s-\s*(Chords|Pro|Lyrics - Chords)(\s*\d+)?(\s*\(1\))?$|\schords$/i;
const COPY = /\s*\(\d+\)$/;            // a browser's duplicate-download suffix

/* A title typed by hand ("Song (version) - Artist"): taken as typed. The old-name guessing of parseFileName (it turns
   "Blues in F" into "Blues (in F)" and drops a trailing "Chords") is for file names, not for what someone just wrote. */
export function parseTypedTitle(text){
  let title = String(text).replace(/\s+/g, ' ').trim(), artist = '';
  const i = title.lastIndexOf(' - ');
  if(i > 0){ artist = title.slice(i + 3).trim(); title = title.slice(0, i).trim(); }
  const m = title.match(/^(.*?)\s*\(([^()]*)\)$/);
  if(m && m[1]) return {song:m[1].trim(), artist, version:m[2].trim()};
  return {song:title, artist, version:''};
}

export function parseFileName(fileName){
  let raw = fileName.replace(/\.pdf$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  /* "Song (in G) (1)": a duplicate-download number after a version in brackets is dropped. "Song (2)" alone stays version 2. */
  raw = raw.replace(/^(.*\))\s*\(\d{1,2}\)$/, '$1');
  if(LEGACY.test(raw)) return splitName(raw);
  let title = raw, artist = '';
  const i = raw.lastIndexOf(' - ');
  if(i < 0 && /\s*\(1\)$/.test(raw)) return splitName(raw);
  if(i > 0){ title = raw.slice(0, i).trim(); artist = raw.slice(i + 3).replace(COPY, '').trim(); }
  const m = title.match(/^(.*?)\s*\(([^()]*)\)$/);
  if(m && m[1]) return {song:m[1].trim(), artist, version:m[2].trim()};
  if(artist) return {song:title, artist, version:''};
  return splitName(raw);
}
