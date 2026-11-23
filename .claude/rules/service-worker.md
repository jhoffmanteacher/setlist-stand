---
paths:
  - "sw.js"
  - "js/main.js"
  - "js/boot.js"
  - "index.html"
  - "manifest.webmanifest"
  - "tools/kill-switch/**"
---

## Writing code here (service worker, updates, install)

Each rule is a real bug the closed loops found.
1. **Never hand-edit `VERSION` in `sw.js`.** `node tools/checks.mjs --bump` writes it; the check fails when a precached file changed and VERSION did not.
2. **A new or renamed app file goes into `PRECACHE`** (checks fail otherwise); a file that 404s at install makes the whole install fail, so the old version keeps running: that is the safe failure, keep it.
3. **An update waits for a tap on "Updated. Tap to reload".** Never reload on `controllerchange` unless this tab's banner was tapped (`asked`); the first install fires `controllerchange` too. It also waits while a restore or backup box is open (`body.busy`, set by `busy()` in `js/util.js`; the banner is hidden then). Only the tapped tab reloads; the open song comes back (`ss-resume`). The kill switch's `ss-sw-killed` message is the one other reload.
4. A change here: run `node tools/loops.mjs --only update`, `--only offline`, `--only kill`. A worker that strands tablets is fixed with `BREAK-GLASS.md` (b), not by a quick second push.

5. **`js/boot.js` stays a classic script loaded first with `defer`** (2026-11-23). `js/main.js` never imports it; they share only `window.ssBoot` (`main.js` registers the worker itself only when it is missing). It must keep working when a module of the app fails to load: that is how a broken deploy is replaced. The registration, the banner, the controllerchange rule and the `ss-sw-killed` reload live there, not in `main.js`. `tools/checks.mjs` ("boot script first") pins it.
6. **A missed file is never stored; `heal()` refills only for the same VERSION** (2026-11-23). Another site on the same origin (guitar-class did, until fixed) or the browser can delete this app's cache. The worker fetches a missing file but does not put it in the cache (a file of a newer deploy must never land in an older version's cache). `js/boot.js` asks for `ss-heal` whenever the app is on screen, online and nothing is open; `heal()` checks the server's `sw.js` VERSION, fetches every missing file, refuses the lot on a failed, redirected or wrong-type answer, then stores all or nothing.
7. **The banner and the update check wait while anything is open**: a song, the splitter, a busy box or any dialog (`quiet()` in `js/boot.js`). An update check runs at most hourly.
