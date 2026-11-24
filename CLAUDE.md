# Setlist Stand

An installable web app (PWA) for a teacher and gigging musician who plays PDF charts from an Android or iPad tablet. Library of PDF charts, setlists, a full-screen viewer with page turns, pen/highlighter annotation, print and backup. It must work fully offline at a gig. One person per library, no sharing. Scope and settled decisions: `docs/DECISIONS.md`. Detail per area is in `.claude/rules/` (loads when you touch matching files).

## Stack rules
- Vanilla JS as ES modules, plain CSS with CSS variables. No build step, no framework, no bundler: the repo files are what GitHub Pages serves.
- No external URLs at runtime; everything loads from this repo by relative path (the app lives under `/setlist-stand/`). One exception (Jonathan, 2026-11-21), Google Drive: data requests to `https://www.googleapis.com` (the CSP's `connect-src`) and navigation to `https://accounts.google.com/o/oauth2/v2/auth` to sign in. Those addresses, the Client ID and the scope live in `js/driveconfig.js` only (`checks.mjs` enforces it). No script is loaded from Google, and there is no client secret anywhere.
- Vendored libs in `vendor/`, exactly: pdf.js 3.11.174, pdf-lib 1.17.1, JSZip 3.10.1. Any other library, framework or build step needs Jonathan's OK.
- No music in the repo, ever. The repo is public.
- One job per file. Split a file when it starts doing two things or passes about 300 to 400 lines, not before. Every new app file goes in `PRECACHE` in `sw.js` (`checks.mjs` fails otherwise).
- Supported devices: tablets (iPadOS 16 or newer, Android Chrome 100 or newer); phones on the same browsers for managing the library and viewing charts in a pinch (no Annotate, no Crop on a phone: `isPhone()` in `js/device.js`, the screen's short side under 600 CSS px, never the user agent; `tools/checks.mjs` fails on any user-agent sniffing). Layout follows the WINDOW (an iPad in Split View gets the narrow layout), features follow the device. Those browser versions are the floor: do not use a browser feature newer than that without a fallback (theme colours have fallbacks for `light-dark()`).

## Layout
- `index.html`, `css/app.css`, `manifest.webmanifest`, `icons/`, `vendor/`, `tests/fixtures/` (small text-only PDFs), `docs/` (`DECISIONS.md`, `THIRD-PARTY.md`), `README.md`, `CHANGELOG.md`
- `js/`, one job per file, named for it:
  - Core: `util` (dialogs, toasts, pdf.js wrapper), `store` (IndexedDB), `saving` (`commit()`, `once()`), `names`, `importname`, `errors`, `nudge`, `backnav`, `main`
  - Library and setlists: `library`, `copysong`, `azstrip`, `collections`, `setlists`, `gigdate`, `gigui`, `setlisttext`, `menubox`
  - Viewer: `viewer`, `pagecache`, `awake`, `ink`, `crop`
  - Output and backup: `print`, `downloadall`, `backup`, `restoreplan`, `restoreask`, `zipread`, `deleteops`
  - Split and share: `songlist`, `songpdf`, `split`, `sharepack`, `share`, `shareimport`, `newversion`, `chartfile`, `chartupdate`
  - Google Drive: `driveconfig`, `googleauth`, `drive`, `driveops`, `syncui`, `sync`, `syncplan`, `syncapply`, `syncmarks`, `syncink`, `syncmerge`, `syncdialogs`, `drivebackup`
- `sw.js`: service worker; precaches every app file; has a `VERSION` constant. A file missing from the cache is fetched but NOT stored; `heal()` (message `ss-heal`, asked by `js/boot.js` when the app is on screen, online and idle) refills missing files only when the server's `sw.js` has the same `VERSION`, all or nothing, refusing a redirected or wrong-type answer.
- `js/boot.js`: a classic `defer` script loaded FIRST from `index.html` (never imported; shares only `window.ssBoot` with `js/main.js`). It registers the service worker, owns the "Updated. Tap to reload" banner, the controllerchange rule and the `ss-sw-killed` reload, and checks for an update at most hourly while the app is on screen, online and idle. It runs even when a broken deploy stops `js/main.js` loading; `js/main.js` registers plainly only when `window.ssBoot` is missing.
- `tools/`: `checks.mjs`, `smoke.mjs`, `lint.mjs`, `make-chart-update.mjs`, `loops.mjs` + `loops/` (`fake-google.mjs` stands in for Google), `plant-faults.mjs`, `names-parity.mjs`, `ci/`, `kill-switch/`, `msb_convert.py` (+ `README.md`)

## Data model
Full text (every shape and settled rule, with dates): `.claude/rules/data-model.md`. **Read it before changing records, backup, restore, sync, sharing, New version, Copy song, collections, gig dates or settings.** Short version:
- IndexedDB `setlist-stand`, version 2 (`DB_VERSION`), stores `songs`, `files`, `sets`, `ink`, `colls`; the names are ONE list, `STORE_NAMES` in `js/store.js`. Raising `DB_VERSION` only creates missing stores.
- Song `{id, title, song, artist, version, archived, colls, pages, hash, added, updated}`; PDF bytes live in `files` by song id and are never changed. Set `{id, name, items, colls, gig?, created, updated}`. Ink key `songId:pageNumber`: strokes and text notes with ids, x and y as fractions of the full page. Collection `{id, name, created, updated}`.
- Deleting leaves `{id, deleted:true, updated}`. Every edit of an existing record stamps it with `stamp(prev)`. `putAll` is the one all-or-nothing write (`ifUpdated` refuses a stale one). Change records by spreading the old one, so unknown fields survive.
- Songs are matched by id, never by hash, except Add PDFs, share import and split (the known limit). Library order is A to Z by song name, made when drawn, never stored.
- Backup is a zip (`library.json` version 3 + `files/<id>.pdf`); restore checks everything, then writes in ONE transaction. Small settings live in `localStorage`, never in the library.
- Google Drive: implicit sign-in, `drive.file` scope, token in memory only, sync only on a tap (`.claude/rules/drive-sync.md`).

## Don't overload Jonathan's Mac
Browser tests start Chromium, and every helper agent starts its own. Rules for Claude and every helper:
- **At most two browser runs at a time** (Jonathan, 2026-11-21). `tools/smoke.mjs` and `tools/loops.mjs` take one of two lock directories in the temp folder (`tools/loops/slot.mjs`) and then wait for the load to settle. Never bypass it: a scratch script that calls `chromium.launch()` must call `await acquireSlot('<name>')` first. `SS_NO_SLOT=1` is for CI only; `SS_SLOTS=1` or `3` change the count (three only when nothing else is busy: measured on this 8-core Mac, three at once sits at the load limit). A run stuck at 0% CPU (an orphan) holds its slot: check `ps` and tell Jonathan; do not queue behind it.
- **Helper agents:** up to four may write code at once if each has its own files; their browser runs share the two slots. Waiting on a slot is fine; starting a browser without one is not. Prefer two or three agents.
- **Heavy runs go to GitHub** (Jonathan, 2026-11-22). The full `smoke` and `loops` run there after every push to `main` and to `ci-try/<anything>` (`.github/workflows/browser.yml`, about 40 minutes). To test a commit before `main`: `git push origin <commit>:refs/heads/ci-try/<name>`, then read the result (`curl -s "https://api.github.com/repos/jhoffmanteacher/setlist-stand/actions/runs?branch=ci-try/<name>"`; annotations name the failing loop, artifacts hold the output). Run LOCALLY only `--only` for what you changed, WebKit (`SS_BROWSER=webkit`) and `plant-faults`. Delete test and review branches when the work order is done.
- Run only what the change needs: `--only <text>`, not the whole suite after every edit. Repeat a run only for a loop that just flaked.
- Start a run longer than a few minutes as `caffeinate -i node ...` (a Mac sleep makes timers fire at wake and gives bogus failures; re-run a single case before believing one).
- No watch modes, no polling loops that start a browser, no second dev server. Check `uptime` before a long run; wait if the load is above the core count.

## Best practices in place (keep them)
- **Security:** a Content-Security-Policy meta in `index.html` (`'self'` only, no `eval`, no outside host except `https://www.googleapis.com` in `connect-src`, `isEvalSupported:false` for pdf.js); no inline script. `tools/checks.mjs` pins the whole policy: loosening it needs Jonathan's OK and a change to the pin in the same commit. `docs/THIRD-PARTY.md` lists every vendored file and license: add a row and the license text in the same commit as any new vendored file.
- **Data safety:** a backup reminder (`js/nudge.js`) shows when anything has CHANGED since the last backup (not by days), with Back up now; full rules in `.claude/rules/data-model.md`. Restore and Drive sync are all or nothing, refuse backups from a newer version, and say plain-language errors through `explainError`. Duplicate PDFs (same hash) are skipped unless Jonathan says "Add anyway".
- **Accessibility and tablet:** every dialog goes through `modal()` (role=dialog, focus trapped and restored, Esc cancels, page behind inert); setlist rows reorder by keyboard (ArrowUp/ArrowDown on the handle); safe-area insets, no rubber-banding or text selection in the viewer, no double-tap zoom delay.
- **Updates:** a new version waits for a tap on "Updated. Tap to reload" (never mid-song); only that tab reloads; the open song comes back.
- **Back gesture:** an open song and each layer over it (Annotate, thickness menu, Crop, a dialog) is ONE history entry, pushed inside the tap that opens it (`js/backnav.js`); back means Escape on the top layer. Library and Setlists add no entry. Details: `.claude/rules/ui-dialogs-csp.md`.

## Closed-loop tests (`node tools/loops.mjs`)
`tools/smoke.mjs` does an action and checks the result. A **closed loop** takes what an action *produces* (a backup zip, a printed PDF, a deployed file, a reloaded page), feeds it back through an independent path (restore it, render it with pdf.js, hash it), and compares with what went in. Nothing is mocked except Google: `tools/loops/fake-google.mjs` stands in for its two addresses at the network edge; the app's code, storage, service worker and CSP run for real. Real Drive is tested by Jonathan on his tablets.
- Loops live in `tools/loops/*.loop.mjs` (each exports `loops = [{name, needs?, run(ctx)}]`; helpers in `harness.mjs`). `--list` shows them, `--only <text>` runs some, `--root <dir>` tests a scratch copy, `--live <url>` adds the deployed-site loops, `--seed N --case N --verbose` replays one random case. A loop whose private input is missing (`needs`) prints SKIP: the MobileSheets files are found in the main checkout's untracked `Claude outputs/` (or `SS_MSB` / `SS_LIBRARY_ZIP`) and are never copied or committed.
- **Which loop after which change:** the table in `.claude/rules/loops.md`. Run that row's `--only` text; GitHub runs the rest.
- Assert the correct behaviour; never weaken a loop to make it pass. A failing loop is a real gap: fix the app. `node tools/plant-faults.mjs` plants mistakes in a scratch copy and requires the right loop to go red (a mistake no loop catches means a missing test). `context.setOffline` does not cut off the service worker, so offline loops also make the server hang up (`goOffline` in `tools/loops/site-copy.mjs`).

## Checks
- `node tools/checks.mjs`: syntax of `js/*.js` and `sw.js`; precache complete; no `http(s)://` in app code (except the four Google addresses in `js/driveconfig.js`); CSP equals the pin; no Google client secret; no `window.claude`; `VERSION` in `sw.js` changed if a precached file changed. `--bump` writes a new VERSION.
- `node tools/smoke.mjs`: Playwright at 1280x800 (add, open, page turns, draw, reload, offline reload, setlist, print, backup/restore).
- Safari engine: `SS_BROWSER=webkit node tools/smoke.mjs` (or `loops.mjs --only ...`; install once with `node node_modules/playwright/cli.js install webkit`). Chromium-only loops skip themselves. Run after dialog, focus, storage or pointer changes. See `tools/README.md`.
- `node tools/lint.mjs`: ESLint via npx (versions pinned in `eslint.config.mjs`); report-only (`--strict` exits 1 on errors); GitHub runs it as the `lint` job.
- Git hooks in `.githooks/` (enable once per clone: `git config core.hooksPath .githooks`): `pre-commit` refuses `.msb`, `.zip`/`.pdf` outside `tests/fixtures/`, anything in `Claude outputs/`, and JS that does not parse; `pre-push` runs `checks.mjs` on a push to `main`. Bypass: `--no-verify`.
- Stop hook (`.claude/hooks/stop-checks.mjs`): after a turn that changed code it runs `checks.mjs` and sends failures back (the "VERSION bumped" line is expected; at most 3 times a turn). Off: `SS_STOP_CHECKS=0`.

## If it goes wrong
`BREAK-GLASS.md` is the plain-language page for Jonathan: a bad update, a broken site, a lost library. `tools/kill-switch/kill-sw.js` is the emergency service worker: it clears the app's caches and never touches the library (`--only kill` proves it). Keep the page true whenever the service worker or update flow changes.

## Working with agents
- **Use agents when they fit (a rule, not an option):** work that is independent of the main session, read-only or on its own files, or needs a view not anchored on the main session's (adversarial review of risky areas always, measurement scripts, mechanical runs, scouting). Do it yourself when it is a few tool calls or its answer is needed for the next step. At most four at once.
- **The main session sets `model` and `effort` on every agent call, for that job** (nothing is inherited). Agents run on **Opus or Sonnet only** (Jonathan, 2026-11-23): Opus for planning, adversarial review and risky builds, Sonnet for builds from a written plan and mechanical work. Never Fable or another model; the main session does not change its own model or effort. **Floor:** an adversarial review of the data layer, restore, the service worker, print, or anything on the "Never" list runs on Opus at `high` or more. A work order's "session effort" line does not cap its agents. Say the choice in one line when it is not obvious.
- **Local agents** work in the worktree, each on its own files, and must not touch `CLAUDE.md`, `.claude/`, `.githooks/`, workflows or the `sw.js` VERSION. **Cloud agents** (`isolation: remote`) are read-only reviewers and see only what is pushed: push the branch first and pin the review to that commit.
- **Saved roles:** `.claude/agents/setlist-reviewer.md` and `setlist-runner.md` hold default model and effort; the main session may override them.
- **Review:** an adversarial reviewer reports file:line, the quoted code, the failing input and the smallest fix. After fixes a FRESH reviewer re-reviews.
- **Reports:** at most 20 lines. An agent's report is a claim: read the diff and run the check yourself.

## Worktree and push rules
- Work in your own worktree, never the main folder: `git fetch`, then `git worktree add ../setlist-stand-wo-<name> -b wo/<name> origin/main`. Run `git worktree list` first; if another worktree has unpushed work in the same files, stop and ask.
- Start each part with `git fetch` and `git rebase origin/main`; push each part before the next. Write `CHANGELOG.md` and bump the `sw.js` VERSION last, after the final rebase, in the part's last commit.
- Push: fetch, rebase if `origin/main` moved, run `node tools/checks.mjs` on the rebased tip, then `git push origin HEAD:main`. Fast-forward only; no merge commits, no force-push. A rebase conflict in anything but `CHANGELOG.md` or the `sw.js` version line: stop and ask.
- Files for Jonathan (screenshots, converted backup) go in the main folder's `Claude outputs/` (untracked; a copy in a worktree is deleted with it).
- After the last push: fast-forward the main folder if clean, confirm `git cherry origin/main wo/<name>` shows no `+`, then remove the worktree and branch.

## Working with Jonathan
He is a teacher, not a developer. Claude handles all git. Ask only product questions, with 2 to 4 options.

## Never, whatever the task says
- Commit music, PDFs (outside `tests/fixtures/`) or `.msb` files.
- Load code from a CDN or any other host at runtime.
- Change a user's PDF bytes. Annotations live apart from the PDF.
- Delete user data without a two-tap confirm.
