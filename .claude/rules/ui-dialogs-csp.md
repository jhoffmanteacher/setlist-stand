---
paths:
  - "js/util.js"
  - "js/setlists.js"
  - "index.html"
  - "css/app.css"
  - "js/driveconfig.js"
  - "js/googleauth.js"
  - "js/drive.js"
  - "js/syncui.js"
---

## Writing code here (dialogs, CSP, layout)

1. **Every dialog goes through `modal()`** (role=dialog, focus trapped and returned, Esc cancels via `[data-x]`, the page behind inert). A dialog whose contents are rewritten must keep an `aria-labelledby` target.
2. **The Content-Security-Policy is strict on purpose:** `'self'` only, no `unsafe-eval`, no inline script, no outside host. The one outside host is `https://www.googleapis.com` in `connect-src` (Jonathan, 2026-11-21: data requests to Google Drive; the sign-in is a page navigation, which a CSP does not govern). `tools/checks.mjs` pins the whole policy: loosen the minimum, only with Jonathan's OK, and change the pin in the same commit. pdf.js runs with `isEvalSupported:false` (the wrapper at the top of `js/util.js`).
3. Tablet feel: keep the safe-area insets, `overscroll-behavior`, `touch-action`, `user-select` rules in the `/* tablet and a11y */` block. Setlist rows reorder by pointer drag and by ArrowUp/ArrowDown on a focused handle.
4. **Full screen is the whole page** (`document.documentElement.requestFullscreen()` in `#vFull`, `js/viewer.js`), never `#viewer` alone. A browser in full screen draws only the full-screen element and what is inside it; dialogs (appended to `body`), `#toast` and `#cropper` are not inside `#viewer`, so they would open out of sight while the viewer behind them is inert (a freeze). The loop `ink: in full screen ...` draws each one and checks the pixels (`onScreen()` in `tools/loops/harness.mjs`).
5. **Google (the Drive connection):** the Client ID and Google's addresses live in `js/driveconfig.js` and nowhere else; no script, library or Picker is ever loaded from Google; no client secret ever. The token is kept in memory only (`js/googleauth.js`; never in any storage), is read only by `getToken()` and is never logged, shown, put in an address, a backup or a share package: only the `Authorization` header carries it. `takeReturn()` runs first in `js/main.js` and takes the `#` part off the address before anything else. Every dialog in `js/syncui.js` and `js/syncdialogs.js` goes through `modal()` and escapes anything that came from Google (names, reasons, messages). Nothing talks to Google unless the person tapped a Drive button (Connect, Sync), and never while a song is open. Change anything here: `node tools/loops.mjs --only sync`.
6. The Library's menus (Share / Import, Back up / Sync) are one `menuBox()` in `js/menubox.js`: a `modal()` of big buttons, each with a one-line hint; the item runs in the very tap that chose it (a file chooser needs that), Cancel and Escape give focus back to the button that opened it. A new menu is one more button in `menusRowHtml()` and one more case in `onClick()` of `js/library.js`; tests open one through `openMenu()` in `tools/loops/harness.mjs`. An open setlist keeps Play setlist, Add songs and Add break on its bar and puts Gig date, Download PDF, Share, Duplicate, Rename and Collections in a More menu (`setMenuItems()` in `js/setlists.js`; tests use `openSetMenu()`): a new setlist action is an item there, not a new bar button.
7. A new overlay over the viewer must close on Escape (its own `[data-x]` or a keydown handler): the back gesture reaches it only through Escape (`pressEscape()` in `js/viewer.js`).
8. After a change: `node tools/loops.mjs --only hygiene-ui`, and `node tools/smoke.mjs` once at the end of a part.
