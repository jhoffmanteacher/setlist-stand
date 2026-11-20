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
4. After a change: `node tools/loops.mjs --only print`, `--only ink`, `--only model`, and `node tools/smoke.mjs` once at the end of a part.
