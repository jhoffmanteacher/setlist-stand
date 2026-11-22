---
paths:
  - "js/viewer.js"
  - "js/ink.js"
  - "js/crop.js"
  - "js/print.js"
---

## Writing code here (viewer, marks, crop, print)

1. **Marks are fractions of the full page AS DISPLAYED** (rotation applied), saved apart from the PDF; a crop only changes what is drawn (`cropOf`), never what is stored.
2. **Print maps every point through `toPdf(box, rot, u, v)`** (strokes, notes, the CropBox); draw marks against the uncropped page first, set the CropBox last. Pages can be rotated 90/180/270 and their boxes can have a non-zero origin.
3. The eraser never erases text notes; Clear page and Undo treat them as documented in CLAUDE.md. Strokes and notes carry `id` and `updated`; removing one writes a tombstone through `reconcile`.
4. **Page turns are readied ahead, inside a memory limit** (`js/viewer.js` "Songs next to this one", `js/pagecache.js`). Both neighbouring spreads are drawn ahead; the songs either side of the one showing (breaks skipped) are kept open in `V.prep` and readied ONE SPREAD EARLY (the next song from the spread before the last, the previous song on the first two spreads: a chart that is a big photo takes about four times as long to draw as a text page, so readying it only on the last page left a quick turn waiting; measured with `page-turn-timing.mjs --photo` / `--dwell 0`), and the spread a turn lands on is drawn into the cache; the song just left stays open for the turn back; everything else is closed and its pages dropped. The page cache is limited by PIXELS (24 million) and count (12), never evicts a render still running or the pages `draw()` holds, and EMPTIES a canvas that leaves it (`width = height = 0`: iPad Safari only takes canvas memory back that way). Cache keys name the open document, not the song. A late render must never paint over a newer page: `draw()` takes `V.dt` first, break page or not. Measure with `node tools/page-turn-timing.mjs --label <x>` (Chromium, CPU throttled; opens the viewer fresh each time) and prove with `--only "page turns"`.
5. A new overlay over the viewer must close on Escape (its own `[data-x]` or a keydown handler): the back gesture reaches it only through Escape (`pressEscape()` in `js/viewer.js`).
6. After a change: `node tools/loops.mjs --only print`, `--only ink`, `--only model`, and `node tools/smoke.mjs` once at the end of a part.
