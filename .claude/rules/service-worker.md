---
paths:
  - "sw.js"
  - "js/main.js"
  - "manifest.webmanifest"
  - "tools/kill-switch/**"
---

## Writing code here (service worker, updates, install)

Each rule is a real bug the closed loops found.
1. **Never hand-edit `VERSION` in `sw.js`.** `node tools/checks.mjs --bump` writes it; the check fails when a precached file changed and VERSION did not.
2. **A new or renamed app file goes into `PRECACHE`** (checks fail otherwise); a file that 404s at install makes the whole install fail, so the old version keeps running: that is the safe failure, keep it.
3. **An update waits for a tap on "Updated. Tap to reload".** Never reload on `controllerchange` unless this tab's banner was tapped (`asked`); the first install fires `controllerchange` too. Only the tapped tab reloads; the open song comes back (`ss-resume`). The kill switch's `ss-sw-killed` message is the one other reload.
4. A change here: run `node tools/loops.mjs --only update`, `--only offline`, `--only kill`. A worker that strands tablets is fixed with `BREAK-GLASS.md` (b), not by a quick second push.
