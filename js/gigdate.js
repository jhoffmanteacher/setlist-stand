/* Gig dates: a setlist may have `gig: 'YYYY-MM-DD'`, a plain calendar date (no time, no time zone), absent when there is none.
   This file holds everything that reads dates and needs no page: checking one, saying it in words, finding one in a setlist's
   name (the one-time fill-in), and grouping the Setlists list. It touches no record: setlists.js saves, js/gigui.js asks.
   - A `gig` that is not a real date in that form is IGNORED wherever a list is drawn (gigOf: like cropOf() ignores a damaged
     rectangle), so the setlist sits under "No date". A restore drops it and counts it (cleanGig, like cleanCrop). The record
     check that sync runs (setProblem in js/backup.js) never refuses a set for a bad gig. */

const pad = n => String(n).padStart(2, '0');
export const YEAR_MIN = 1900, YEAR_MAX = 2999;

/* A real calendar date as 'YYYY-MM-DD' (February 31 is not one), or null. */
export function validGig(v){
  if(typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); if(!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if(y < YEAR_MIN || y > YEAR_MAX || mo < 1 || mo > 12 || d < 1) return null;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() ? v : null;
}
/* The date a setlist shows: its gig if it is a real date, else null. */
export const gigOf = st => st && st.gig != null ? validGig(st.gig) : null;
/* What a restore does with a set's gig: {gig, dropped}. Absent stays absent; a bad one is dropped and counted. */
export function cleanGig(v){
  if(v == null) return {gig:null, dropped:0};
  const g = validGig(v);
  return g ? {gig:g, dropped:0} : {gig:null, dropped:1};
}

export function todayStr(d = new Date()){ return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
const toDate = g => { const [y, m, d] = g.split('-').map(Number); return new Date(y, m - 1, d); };
let LONG = null, SHORT = null;
/* "Saturday, October 18, 2026" and "Sat, Oct 18, 2026", in the tablet's own language and calendar. */
export function gigLong(g){
  LONG = LONG || new Intl.DateTimeFormat(undefined, {weekday:'long', year:'numeric', month:'long', day:'numeric'});
  return LONG.format(toDate(g));
}
export function gigShort(g){
  SHORT = SHORT || new Intl.DateTimeFormat(undefined, {weekday:'short', year:'numeric', month:'short', day:'numeric'});
  return SHORT.format(toDate(g));
}

/* ---------- a full date inside a setlist's name (the one-time fill-in) ----------
   "Clearly a full date": a month name (full, or the usual three letters, any case) with a day and a four-digit year in either
   order ("October 18 2026", "18 Oct 2026", "Oct 18, 2026"), or YYYY-MM-DD, or M/D/YYYY, and the date must exist. A name with
   two date-shaped parts, one with no year or only two digits of year, or one that is not a real date is never a date. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
/* No lookbehind (iPadOS 16.0 to 16.3 cannot parse one, and a module that fails to parse stops the whole app): what comes
   before a match is checked in dateInName() instead. */
const NAME_DATE = new RegExp([
  '(\\d{4})-(\\d{2})-(\\d{2})(?![\\d-])',                         // 1 2 3: YYYY-MM-DD
  '(\\d{1,2})/(\\d{1,2})/(\\d{4})(?![\\d/])',                      // 4 5 6: M/D/YYYY
  `${MON}\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})(?!\\d)`,                    // 7 8 9: Month D YYYY
  `(\\d{1,2})\\s+${MON}\\.?,?\\s+(\\d{4})(?!\\d)`,                    // 10 11 12: D Month YYYY
].join('|'), 'gi');
/* The character before a match must not run into it: not a digit (or "-" or "/" for the numeric forms), not a letter before a month name. */
const PREV_OK = [/^[\d-]$/, /^[\d/]$/, /^[a-z]$/i, /^\d$/];
export function dateInName(name){
  if(typeof name !== 'string') return null;
  const found = [...name.matchAll(NAME_DATE)].filter(m => {
    const alt = m[1] ? 0 : m[4] ? 1 : m[7] ? 2 : 3, prev = m.index ? name[m.index - 1] : '';
    return !PREV_OK[alt].test(prev);                            // "12026-10-18" or "Xoct 18 2026" is not a date
  });
  if(found.length !== 1) return null;                           // none, or two dates: left blank
  const m = found[0];
  const mon = s => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;
  let y, mo, d;
  if(m[1]) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if(m[4]) [mo, d, y] = [+m[4], +m[5], +m[6]];
  else if(m[7]) [mo, d, y] = [mon(m[7]), +m[8], +m[9]];
  else [d, mo, y] = [+m[10], mon(m[11]), +m[12]];
  return validGig(`${String(y).padStart(4, '0')}-${pad(mo)}-${pad(d)}`);
}
/* The setlists the fill-in would offer: no real gig yet, and a name that clearly holds a date. [{set, gig}] */
export const fillCandidates = sets => sets.filter(st => !st.deleted && !gigOf(st)).map(st => ({set:st, gig:dateInName(st.name)})).filter(c => c.gig);

/* ---------- the Setlists list in groups ----------
   Upcoming (today or later, any year, soonest first), then this year's past gigs (newest first), then No date (newest made
   first), then each earlier year (newest year first, collapsed to start with). null when no setlist has a date: the list
   then looks as it always did, without headers. A group with nothing in it is left out. */
export function groupSets(sets, today = todayStr()){
  if(!sets.some(gigOf)) return null;
  const year = +today.slice(0, 4), by = (a, b) => b.created - a.created || (a.id < b.id ? -1 : 1);
  const upcoming = [], thisYear = [], none = [], earlier = new Map();
  for(const st of sets){
    const g = gigOf(st);
    if(!g) none.push(st);
    else if(g >= today) upcoming.push(st);
    else if(+g.slice(0, 4) === year) thisYear.push(st);
    else { const y = g.slice(0, 4); if(!earlier.has(y)) earlier.set(y, []); earlier.get(y).push(st); }
  }
  const asc = (a, b) => (gigOf(a) < gigOf(b) ? -1 : gigOf(a) > gigOf(b) ? 1 : by(a, b));
  const desc = (a, b) => (gigOf(a) < gigOf(b) ? 1 : gigOf(a) > gigOf(b) ? -1 : by(a, b));
  const out = [
    {id:'up', label:'Upcoming', sets:upcoming.sort(asc), open:true},
    {id:'y' + year, label:String(year), sets:thisYear.sort(desc), open:true},
    {id:'none', label:'No date', sets:none.sort(by), open:true},
    ...[...earlier.keys()].sort().reverse().map(y => ({id:'y' + y, label:y, sets:earlier.get(y).sort(desc), open:false})),
  ];
  return out.filter(g => g.sets.length);
}
/* Which groups the person has opened or closed, kept while the app is open (past years start closed again after a reload). */
const toggled = new Map();
export const isOpen = g => toggled.has(g.id) ? toggled.get(g.id) : g.open;
export const toggleGroup = g => toggled.set(g.id, !isOpen(g));
