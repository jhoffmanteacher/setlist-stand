/* The rendered pages the viewer keeps so a turn needs no waiting: key -> Promise of {cv, cw, ch, crop} (see renderPage in
   viewer.js). It is a Map, so anything that reads it as one still works.

   MEMORY. iPad Safari gives a tab a fixed total for ALL its canvases (about 384 MB on current iPads, as little as 256 MB
   on older ones) and answers an over-full tab by failing to draw or reloading it, and it takes memory back from a
   canvas only when the canvas is made empty (width = height = 0), not when it is merely forgotten. So the cache is
   limited by PIXELS, not only by count, and a canvas that leaves it is emptied:
     MAX_PIXELS 24 million (96 MB of RGBA): about 12 pages at a typical 2 megapixels (one page filling a 1280x800
       window at 2x), 8 at the largest a tablet draws (2.5x, 2.8 megapixels). The page on screen, its two neighbours
       and the first/last spread of the songs either side need about 10 at most. The ink layers on screen (the same
       size again, for the pages showing, never cached) bring the worst case near 110 MB, well under both limits; the
       old limit was 10 pages whatever their size.
     MAX_ENTRIES 12: a bound for tiny pages, where pixels alone would allow dozens.
   Oldest first goes (a hit makes an entry newest). Never evicted: a render still running (its size is only an
   estimate until it ends) and the pages a draw() is waiting for (hold()). An evicted canvas that is on screen is left
   alone and emptied when the viewer replaces it (unused()); one that is not is emptied a tick later, so code that has
   just been handed it finishes first. */
export const MAX_PIXELS = 24e6, MAX_ENTRIES = 12;

export function release(cv){ cv.width = 0; cv.height = 0; }

export class PageCache extends Map {
  constructor(){
    super();
    this.px = new Map();           // key -> pixels (an estimate until the render ends, then the canvas's own)
    this.settled = new Set();      // keys whose render has ended
    this.held = new Set();         // the canvases the cache keeps
    this.pinned = new Set();       // keys that must not be evicted now
  }
  /* The entry for key, made the newest, or undefined. */
  hit(key){ const p = this.get(key); if(p){ this.delete(key); this.set(key, p); } return p; }
  /* Adds a render. estimate: pixels it will probably take, used until it has ended. */
  put(key, promise, estimate){
    this.set(key, promise); this.px.set(key, estimate);
    promise.then(r => {
      if(this.get(key) !== promise){ this.later(r.cv); return; }       // evicted or cleared while it ran
      this.px.set(key, r.cv.width * r.cv.height); this.settled.add(key); this.held.add(r.cv); this.trim();
    }, () => { if(this.get(key) === promise) this.drop(key); });
    this.trim();
  }
  drop(key){ this.delete(key); this.px.delete(key); this.settled.delete(key); }
  total(){ let n = 0; for(const v of this.px.values()) n += v; return n; }
  /* Keeps these keys out of eviction until the returned function is called (draw() holds the pages it will show). */
  hold(keys){ for(const k of keys) this.pinned.add(k); return () => { for(const k of keys) this.pinned.delete(k); this.trim(); }; }
  trim(){
    let total = this.total();
    for(const [key, p] of [...this.entries()]){
      if(total <= MAX_PIXELS && this.size <= MAX_ENTRIES) return;
      if(this.pinned.has(key) || !this.settled.has(key)) continue;
      total -= this.px.get(key) || 0; this.evict(key, p);
    }
  }
  evict(key, p){
    this.drop(key);
    p.then(r => { this.held.delete(r.cv); this.later(r.cv); }, () => {});
  }
  later(cv){ setTimeout(() => { if(!cv.isConnected && !this.held.has(cv)) release(cv); }, 0); }
  /* For a canvas that has just left the screen: emptied unless the cache still keeps it. */
  unused(cv){ if(!this.held.has(cv)) release(cv); }
  /* Every entry whose key starts with prefix goes (a song's pages, when its PDF is closed). */
  dropPrefix(prefix){ for(const [key, p] of [...this.entries()]) if(key.startsWith(prefix)) this.evict(key, p); }
  clear(){ for(const [key, p] of [...this.entries()]) this.evict(key, p); this.pinned.clear(); }
}
