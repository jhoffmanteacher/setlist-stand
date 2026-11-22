/* Sync merge: decides, record by record, what one Google Drive sync does. Pure: no screen, no database, no network;
   the same file runs in the browser and in Node (tools/loops/syncmerge.loop.mjs tests it there).

   A record is a whole song, setlist or collection (every field, known or not), or its deletion marker
   {id, deleted:true, updated}. Each side is described by an entry per id: {u: its `updated`, c: the SHA-256 of
   canon(record), d: true for a marker}. Records are matched by id only, never by title or PDF hash.

   The rules, for each id seen on either side (L = this tablet, R = Drive). A record one side does not have is
   never taken as a deletion: only a marker deletes.
     only L (live or marker)          up         Drive has never seen it
     only R, live                     down       new from another tablet
     only R, marker                   nothing    created and deleted elsewhere; never here
     L.u > R.u                        up         this tablet's version is newer (a live edit beats an older marker too)
     L.u < R.u, R live                down       the newer live record wins, over an older local marker too
     L.u < R.u, R marker, L live      askDelete  deleted on another tablet: nothing goes until the person taps
     L.u < R.u, R marker, L marker    nothing    deleted on both
     L.u = R.u, same c                nothing    the same record (counted in `same`)
     L.u = R.u, R marker, L live      askDelete  a deletion is never done on its own, not even by a tie
     L.u = R.u, L marker, R live      up         this tablet's deletion was confirmed here; the other tablet is asked
     L.u = R.u, different c, else     tie        the caller downloads R and asks breakTie(local, remote)
   breakTie keeps the record whose canon text is the larger, so both tablets pick the same one and agree.
   `future`: entries with a `u` more than a day after `now` (a tablet whose clock is ahead). They still sync;
   the report names them. Actions come out ordered by KINDS, then by id, so two runs on the same input agree. */

export const KINDS = ['coll', 'song', 'set'];            // the order downloads run in
const DAY = 864e5;
const HEX64 = /^[0-9a-f]{64}$/;

/* JSON text with object keys sorted at every depth, arrays in order, no spaces. Anything JSON cannot carry exactly
   (undefined, NaN, Infinity, a function, a Date, a cycle) is refused: a record must never canonicalise to something else. */
export function canon(value){
  const seen = new Set();
  const walk = (v, at) => {
    if(v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if(typeof v === 'number'){
      if(!Number.isFinite(v)) throw new TypeError(`canon: ${v} at ${at} is not a finite number`);
      return JSON.stringify(v);
    }
    if(typeof v !== 'object') throw new TypeError(`canon: ${typeof v} at ${at} cannot be stored`);
    if(seen.has(v)) throw new TypeError(`canon: ${at} refers back to itself`);
    const proto = Object.getPrototypeOf(v);
    if(!Array.isArray(v) && proto !== Object.prototype && proto !== null) throw new TypeError(`canon: ${at} is not a plain object`);
    seen.add(v);
    let out;
    if(Array.isArray(v)){
      const parts = [];
      for(let i = 0; i < v.length; i++){
        if(!(i in v)) throw new TypeError(`canon: ${at}[${i}] is empty`);
        parts.push(walk(v[i], `${at}[${i}]`));
      }
      out = '[' + parts.join(',') + ']';
    } else {
      out = '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + walk(v[k], `${at}.${k}`)).join(',') + '}';
    }
    seen.delete(v);
    return out;
  };
  return walk(value, 'record');
}

/* Lower-case hex SHA-256 of the text's UTF-8 bytes. */
export async function digest(text){
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

/* The entries for this tablet's records of one kind (live ones and markers). A record with no `updated` counts as 0. */
export async function indexOf(records){
  const map = new Map();
  for(const r of records){
    if(!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) throw new TypeError('indexOf: a record without an id');
    if(map.has(r.id)) throw new TypeError(`indexOf: id ${r.id} twice`);
    const u = r.updated == null ? 0 : r.updated;
    if(typeof u !== 'number' || !Number.isFinite(u)) throw new TypeError(`indexOf: ${r.id} has updated ${r.updated}`);
    map.set(r.id, {u, c: await digest(canon(r)), d: r.deleted === true});
  }
  return map;
}

const checkEntry = (e, side, kind, id) => {
  if(!e || typeof e.u !== 'number' || !Number.isFinite(e.u) || typeof e.c !== 'string' || !HEX64.test(e.c))
    throw new TypeError(`plan: ${side} ${kind} ${id} has no usable u and c`);
  return e;
};

/* What to do for one id; L or R may be missing. */
function decide(L, R){
  if(!R) return 'up';
  if(!L) return R.d ? null : 'down';
  if(L.u > R.u) return 'up';
  if(L.u < R.u){
    if(!R.d) return 'down';
    return L.d ? null : 'askDelete';
  }
  if(L.c === R.c) return 'same';
  if(R.d && !L.d) return 'askDelete';                    // same time: a marker never wins a tie over a live record
  if(L.d && !R.d) return 'up';
  return 'tie';
}

export function plan(local, remote, {now = Date.now()} = {}){
  const actions = [], future = [];
  let same = 0;
  for(const kind of KINDS){
    const lm = (local && local[kind]) || new Map(), rm = (remote && remote[kind]) || new Map();
    const ids = [...new Set([...lm.keys(), ...rm.keys()])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for(const id of ids){
      const L = lm.has(id) ? checkEntry(lm.get(id), 'local', kind, id) : null;
      const R = rm.has(id) ? checkEntry(rm.get(id), 'remote', kind, id) : null;
      const ahead = [L, R].filter(e => e && e.u > now + DAY).map(e => e.u);
      if(ahead.length) future.push({kind, id, u: Math.max(...ahead)});
      const op = decide(L, R);
      if(op === 'same') same++;
      else if(op) actions.push({op, kind, id});
    }
  }
  return {actions, future, same};
}

/* Two different records with the same `updated`: keep the one whose canon text is the larger. Tablet A asks
   breakTie(mine, Drive's) and tablet B asks breakTie(Drive's, mine): both name the same record. */
export function breakTie(localRecord, remoteRecord){
  return canon(localRecord) >= canon(remoteRecord) ? 'local' : 'remote';
}
