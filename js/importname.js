/* Turns a PDF file name into {song, artist, version}.
   Convention (title first):  "Song Title (version) - Artist.pdf"   e.g. "War Pigs - Black Sabbath.pdf", "Flowers in the Ashes (in G).pdf"
   Old MobileSheets-style names ("Artist - Title - Chords", "Title OLD", "Title in G") still go through splitName(). */
import {splitName} from './names.js';

const LEGACY = /\s-\s*(Chords|Pro|Lyrics - Chords)(\s*\d+)?$|\s*\(1\)$|\schords$/i;

export function parseFileName(fileName){
  const raw = fileName.replace(/\.pdf$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if(LEGACY.test(raw)) return splitName(raw);
  let title = raw, artist = '';
  const i = raw.lastIndexOf(' - ');
  if(i > 0){ title = raw.slice(0, i).trim(); artist = raw.slice(i + 3).trim(); }
  const m = title.match(/^(.*?)\s*\(([^()]*)\)$/);
  if(m && m[1]) return {song:m[1].trim(), artist, version:m[2].trim()};
  if(artist) return {song:title, artist, version:''};
  return splitName(raw);
}
