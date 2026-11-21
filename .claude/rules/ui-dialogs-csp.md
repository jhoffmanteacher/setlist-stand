---
paths:
  - "js/util.js"
  - "js/setlists.js"
  - "index.html"
  - "css/app.css"
---

## Writing code here (dialogs, CSP, layout)

1. **Every dialog goes through `modal()`** (role=dialog, focus trapped and returned, Esc cancels via `[data-x]`, the page behind inert). A dialog whose contents are rewritten must keep an `aria-labelledby` target.
2. **The Content-Security-Policy is strict on purpose:** `'self'` only, no `unsafe-eval`, no inline script, no outside host. Loosen the minimum and only with Jonathan's OK; pdf.js runs with `isEvalSupported:false` (the wrapper at the top of `js/util.js`).
3. Tablet feel: keep the safe-area insets, `overscroll-behavior`, `touch-action`, `user-select` rules in the `/* tablet and a11y */` block. Setlist rows reorder by pointer drag and by ArrowUp/ArrowDown on a focused handle.
4. **Full screen is the whole page** (`document.documentElement.requestFullscreen()` in `#vFull`, `js/viewer.js`), never `#viewer` alone. A browser in full screen draws only the full-screen element and what is inside it; dialogs (appended to `body`), `#toast` and `#cropper` are not inside `#viewer`, so they would open out of sight while the viewer behind them is inert (a freeze). The loop `ink: in full screen ...` draws each one and checks the pixels (`onScreen()` in `tools/loops/harness.mjs`).
5. After a change: `node tools/loops.mjs --only hygiene-ui`, and `node tools/smoke.mjs` once at the end of a part.
