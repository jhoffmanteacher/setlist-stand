# Setlist Stand

An installable web app (PWA) for a teacher and gigging musician who plays PDF charts from an Android or iPad tablet. Library of PDF charts, setlists, a full-screen viewer with page turns, pen/highlighter annotation, print and backup. It must work fully offline at a gig. One person per library, no sharing. Scope and settled decisions: `docs/DECISIONS.md`.

## Stack rules
- Vanilla JS as ES modules, plain CSS with CSS variables. No build step, no framework, no bundler: the repo files are the files GitHub Pages serves.
- No external URLs at runtime. Everything loads from this repo, with relative paths (the app lives under `/setlist-stand/`).
- Vendored libs in `vendor/`, exactly: pdf.js 3.11.174, pdf-lib 1.17.1, JSZip 3.10.1. Adding any other library, framework or build step needs Jonathan's OK.
- No music in the repo, ever. The repo is public.
- One job per file. Split a file when it starts doing two things or passes about 300 to 400 lines, and not before: do not cut a file only to make it shorter. Every new app file must be added to `PRECACHE` in `sw.js` (`checks.mjs` fails if it is not).
- Supported tablets: iPadOS 16 or newer, Android Chrome 100 or newer. Do not use a browser feature newer than that without a fallback (theme colours have fallbacks for `light-dark()`).

## Layout
- `index.html`, `css/app.css`, `manifest.webmanifest`, `icons/`
- `js/`: `util` (dialogs with focus handling, toasts, the pdf.js wrapper), `store` (IndexedDB), `names`, `importname`, `errors` (problem log, plain-language errors), `library`, `setlists`, `viewer`, `ink`, `crop`, `print`, `backup`, `main`
- `sw.js`: service worker; precaches every app file; has a `VERSION` constant
- `vendor/`: the three libraries
- `tools/`: `checks.mjs`, `smoke.mjs`, `loops.mjs` + `loops/` (closed loops), `plant-faults.mjs`, `names-parity.mjs`, `ci/`, `msb_convert.py` (+ `README.md`)
- `tests/fixtures/`: small text-only PDFs for the smoke test
- `docs/`: `DECISIONS.md`. Root: `README.md`, `CHANGELOG.md`

## Data model (as of v1 part 4)
- IndexedDB `setlist-stand`, version 1, stores `songs`, `files`, `sets`, `ink` (in-memory fallback if storage is blocked).
- Song `{id, title, song, artist, version, archived, pages, hash, added, updated}`. `title` is derived: "Song (version) - Artist" (empty parts left out). `hash` is SHA-256 of the PDF bytes. Old records (title only) are upgraded on load with the splitter in `js/names.js` (a port of `split_name()` in `tools/msb_convert.py`; `node tools/names-parity.mjs <.msb>` must print "N of N match"). New imports use `js/importname.js` (title-first file names, legacy names fall back to the splitter). PDF bytes live in `files`, keyed by song id.
- Song crop (optional): `crop: {all: rect|null, pages: {"<page number>": rect}}`, rect `{x, y, w, h}` as fractions of the FULL page (x, y = top-left of the kept part). A page's own crop wins over `all`. `cropOf(song, pn)` in `js/store.js` is the one place that decides. The viewer draws only the kept part, scaled up; print sets the page's CropBox (after drawing marks against the uncropped page).
- Text notes live in the same ink list as strokes: `{id, t:'text', x, y, text, size, c, updated}`, x,y = top-left as full-page fractions, size = font size as a fraction of page width (small .012, medium .018, large .028). The eraser does not touch them. They undo, print and back up like strokes.
- Set `{id, name, items:[{type:'song', id} | {type:'break', id, name}], created, updated}`. Old sets with a `songs` array are upgraded on load and on restore (`upgradeSet`). A song can appear twice; rows are identified by position. Breaks are not songs: print skips them, the viewer shows a full-screen break page (name and "Next: <song>"), and the song before a break says "Next: <break name>". Reordering is drag and drop from the handle (pointer events, `initSetlists()` in `js/setlists.js`); there are no up/down buttons; with a handle focused, ArrowUp/ArrowDown move the row (keyboard reorder).
- Ink: key `songId:pageNumber` -> `{updated, strokes:[...]}`. A stroke is `{id, t:'pen'|'hl', c:'#rrggbb', w:<fraction of page width>, p:[[x,y],...], updated}`; x and y are fractions (0 to 1) of the full page. Keep them that way. An erased stroke becomes `{id, deleted:true, updated}`. Older data stored a bare array without ids; `upgradeInk()` fixes it on first read.
- Deleting a song or setlist leaves `{id, deleted:true, updated}` in its store (the song's PDF and ink pages are removed). The UI never shows markers; backups include them. This is so a later Google Drive sync can tell "deleted" from "never had it": merge by id, newest `updated` wins.
- Archived songs are hidden from the library (shown with "Show archived"), but still show and play in setlists.
- Small settings live in the browser's own storage, never in IndexedDB: `localStorage` `ss-two` (two pages), `ss-last-backup` (time of the last backup download, for the nudge), `ss-problems` (the private problem log: last 30 errors, never sent anywhere); `sessionStorage` `ss-resume` (the open song, put back after an update reload).
- Restore (`restoreFrom`) checks everything first (zip CRC, `library.json` ours and not from a newer version, every song's PDF present and matching its hash) and then writes all four stores in ONE transaction (`putAll`): it is all or nothing.
- Backup is a zip: `library.json` `{app:'setlist-stand', version:2, ...}` plus `files/<id>.pdf`. Version 1 (the prototype and the converter's output) must keep restoring.

## Don't overload Jonathan's Mac
The browser tests start Chromium (and a long run starts hundreds of pages), and helper agents each start their own. Several at once make the Mac crawl. Rules, for Claude and for every helper agent it starts:
- **One browser run at a time.** `tools/smoke.mjs` and `tools/loops.mjs` take a lock (`setlist-stand-browser.lock` in the temp folder; `tools/loops/slot.mjs`) and wait their turn, then wait until the machine's load is below 75% of its cores (up to 5 minutes). Never bypass it: a scratch script that calls `chromium.launch()` must call `await acquireSlot('<name>')` first. `SS_NO_SLOT=1` is for CI runners only.
- **Helper agents:** several may write code at once if each has its own files (that costs the Mac little), but never more than four, and their browser runs all go through the one slot above, so only one of them tests at a time. A helper that is waiting on the slot is fine; starting a second browser on its own is not. Prefer two or three agents; use four only for clearly separate files.
- **Run only what the change needs.** Use `--only <text>` for one loop, not the whole suite after every edit. Run the full `smoke` and `loops` once, at the end of a part. Three clean runs in a row only for a loop that has just flaked, not as a habit.
- No watch modes, no polling loops that start a browser, no second dev server while one is running. Check `uptime` before a long run; if the load average is above the core count, wait.
- GitHub runs the full walk after every push (`.github/workflows/browser.yml`); a run on the Mac is for the area just changed.

## Best practices already in place (keep them)
- **Security:** a Content-Security-Policy meta in `index.html` (`'self'` only, no `eval`, no outside hosts, `isEvalSupported:false` for pdf.js); no inline script; no outside request at runtime. Loosen it only with Jonathan's OK. `docs/THIRD-PARTY.md` lists every vendored file and its license: add a row and the license text in the same commit as any new vendored file.
- **Data safety:** a backup nudge (banner after 14 days or never), a storage line (used, free, protected or not, "Ask the browser to protect it"), a restore that is all or nothing, a refusal of backups from a newer version, and plain-language errors ("The tablet is full...") through `explainError`. Duplicate PDFs (same hash) are skipped unless Jonathan says "Add anyway".
- **Accessibility and tablet:** every dialog goes through `modal()` (role=dialog, focus trapped and restored, Esc cancels, the page behind is inert); setlist rows reorder by keyboard (handle focused, ArrowUp/ArrowDown); safe-area insets, no rubber-banding or text selection in the viewer, no double-tap zoom delay.
- **Updates:** a new version waits for a tap on "Updated. Tap to reload" (never mid-song); only that tab reloads; the open song comes back.

## Closed-loop tests (`node tools/loops.mjs`)
`tools/smoke.mjs` does an action and checks the result. A **closed loop** takes what an action *produces* (a backup zip, a printed PDF, a deployed file, a reloaded page) and feeds it back through an independent path (restore it, render it with pdf.js, hash it, read the source of truth), then compares with what went in. Nothing is mocked. Loops live in `tools/loops/*.loop.mjs` (each exports `loops = [{name, needs?, run(ctx)}]`; helpers in `tools/loops/harness.mjs`). `node tools/loops.mjs --list` shows them; `--only <text>` runs some; `--root <dir>` tests a scratch copy; `--live <url>` adds the deployed-site loops; `--seed N --case N --verbose` replays one case of the random loop. A loop whose private input is missing (`needs`) prints SKIP, never FAIL: the MobileSheets files are found in the main checkout's untracked `Claude outputs/` (or `SS_MSB` / `SS_LIBRARY_ZIP`) and are never copied or committed.

| Changed | Run after (one browser run at a time, see above) | What it closes |
|---|---|---|
| `js/backup.js`, restore or backup format, `putAll`, record shapes in `js/store.js` | `--only roundtrip` | backup -> wipe -> restore gives back every record and every PDF byte; v1 backups upgrade; a damaged or interrupted restore changes nothing; the converter output equals the MobileSheets backup it came from |
| `js/print.js`, `js/crop.js`, crop or text-note drawing in `js/ink.js` / `js/viewer.js` | `--only print` | the printed PDF, rendered again with pdf.js, has marks, notes and crops where the viewer shows them, on rotated pages too |
| `sw.js`, `js/main.js` (update banner, resume), `manifest.webmanifest`, any precached file added or renamed | `--only update` and `--only offline` | first install never reloads; an update waits for a tap, reloads once, puts the open song back, keeps the library; a broken deploy keeps the old version; the whole app, print and backup work with no network |
| anything users do in the library, setlists, ink, crops or notes | `--only model` | seeded random action sequences agree with an independent model, after a reload and after a backup round trip |
| `tools/kill-switch/kill-sw.js`, the `ss-sw-killed` message handling in `js/main.js` | `--only kill` | armed, the emergency worker empties the cache, the open tab reloads once and the library is untouched; disarmed, the real worker and offline come back |
| `js/store.js`, `js/backup.js`, `js/library.js` (replace, delete), record validation, ids in HTML, `tools/msb_convert.py` | `--only hardening` | damaged or hostile records and backups are refused or healed, writes are all-or-nothing, an aborted save never hangs, the converter reports what it cannot read |
| `js/viewer.js`, `js/ink.js` (gestures), `js/print.js` (encrypted, bad points), `sw.js` install, `js/main.js` update tracking, `js/util.js` dialogs, `css/app.css` colours, setlist drag | `--only viewer-hardening` | a page turn never moves a stroke, a locked PDF is named and never printed blank, a deploy installs the new files, dialogs behave on Enter, colours have fallbacks |
| a deploy (GitHub Pages) | `--only live --live https://jhoffmanteacher.github.io/setlist-stand/` (CI does this after every Pages deploy: `.github/workflows/deployed-site.yml`) | every precached file on the site equals the repo's; a fresh browser installs it under `/setlist-stand/` and works offline |

Rules: assert the correct behaviour and never weaken a loop to make it pass; a failing loop is a real gap, so fix the app. `node tools/plant-faults.mjs` plants deliberate mistakes in a scratch copy and requires the right loop to go red (a mistake no loop catches is a gap in the loops; add the test). `context.setOffline` does not cut off the service worker, so offline loops also make the server hang up (`goOffline` in `tools/loops/site-copy.mjs`; `offline.drop` in the smoke test).

## Checks
- `node tools/checks.mjs`: syntax of `js/*.js` and `sw.js`; every precached file exists and every app file is precached; no `http(s)://` in app code; no `window.claude`; `VERSION` in `sw.js` changed if a precached file changed.
- `node tools/checks.mjs --bump`: writes a new `sw.js` VERSION.
- `node tools/smoke.mjs`: Playwright run at 1280x800 (add, open, page turns, draw, reload, offline reload, setlist, print, backup/restore).
- `node tools/lint.mjs`: ESLint (fetched by npx at the versions pinned in `eslint.config.mjs`, nothing installed) for undefined names, dead code and similar slips in `js/`, `sw.js` and `tools/`. Report-only (`--verbose` lists warnings, `--strict` exits 1 on errors); GitHub runs it as the `lint` job.
- Git hooks in `.githooks/` (enable once per clone: `git config core.hooksPath .githooks`). `pre-commit` refuses `.msb`, `.zip`/`.pdf` outside `tests/fixtures/`, anything in `Claude outputs/`, and staged JS that does not parse. `pre-push` runs `node tools/checks.mjs` on a push to `main` (HEAD, clean tree) and refuses on a FAIL; branch pushes pass. Bypass: `--no-verify`.
- Stop hook (`.claude/hooks/stop-checks.mjs`, `.claude/settings.json`): at the end of a turn that changed code files it runs `node tools/checks.mjs` and sends failures back (the "VERSION bumped" line is expected and ignored; at most 3 times a turn). Off switch: `SS_STOP_CHECKS=0`.

## If it goes wrong
`BREAK-GLASS.md` (repo root) is the plain-language page for Jonathan: a bad update on a tablet, a broken site, a lost library. `tools/kill-switch/kill-sw.js` is the emergency service worker that clears the app's caches and never touches the library; `node tools/loops.mjs --only kill` proves it. Keep that page true whenever the service worker or update flow changes.

## Working with agents
- **Local agents** work in the worktree and may edit code. Give each its own files, tell it not to touch `CLAUDE.md`, `.claude/`, `.githooks/`, workflows or the `sw.js` VERSION, and keep to at most four at once (see "Don't overload Jonathan's Mac").
- **Cloud agents** (`isolation: remote`) are read-only reviewers. They see only what has been pushed to a branch, so push the branch first and pin the review to that commit.
- **Model:** Sonnet for mechanical work (running the loops, plain edits, regenerating files); Opus for risky areas (data layer, restore, service worker, print) and for adversarial review. `.claude/agents/setlist-reviewer.md` and `setlist-runner.md` hold these two roles.
- **Review:** an adversarial reviewer reports findings as file:line, the quoted code, the failing input and the smallest fix. After fixes, a FRESH reviewer re-reviews, not the one that found them.
- **Reports:** at most 20 lines. Treat what an agent says as a claim: read the diff and run the check yourself before relying on it.
- **Rules for each area** are in `.claude/rules/` (service worker, data and backup, viewer and print, dialogs and CSP).

## Worktree and push rules (from the work order)
- Work in your own worktree, never the main folder: `git fetch`, then `git worktree add ../setlist-stand-wo-<name> -b wo/<name> origin/main`. Run `git worktree list` first; if another worktree has unpushed work in the same files, stop and ask.
- Start every part with `git fetch` and `git rebase origin/main`. Ship each part (push) before starting the next.
- Write `CHANGELOG.md` and bump the `sw.js` VERSION last, after the final rebase, in the part's last commit.
- Push: fetch, rebase if `origin/main` moved, run `node tools/checks.mjs` on the rebased tip, then `git push origin HEAD:main`. Fast-forward only. No merge commits, no force-push.
- If a rebase conflicts in anything besides `CHANGELOG.md` or the `sw.js` version line, stop and ask.
- Files for Jonathan (screenshots, converted backup) go in the main folder's `Claude outputs/`. It is untracked and gitignored; a copy left in a worktree is deleted with it.
- After the last push: fast-forward the main folder if clean, confirm `git cherry origin/main wo/<name>` shows no `+`, then remove the worktree and branch.

## Working with Jonathan
He is a teacher, not a developer. Claude handles all git. Ask only product questions, with 2 to 4 options.

## Never, whatever the task says
- Commit music, PDFs (outside `tests/fixtures/`) or `.msb` files.
- Load code from a CDN or any other host at runtime.
- Change a user's PDF bytes. Annotations live apart from the PDF.
- Delete user data without a two-tap confirm.
