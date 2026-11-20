# Setlist Stand

An installable web app (PWA) for a teacher and gigging musician who plays PDF charts from an Android or iPad tablet. Library of PDF charts, setlists, a full-screen viewer with page turns, pen/highlighter annotation, print and backup. It must work fully offline at a gig. One person per library, no sharing. Scope and settled decisions: `docs/DECISIONS.md`.

## Stack rules
- Vanilla JS as ES modules, plain CSS with CSS variables. No build step, no framework, no bundler: the repo files are the files GitHub Pages serves.
- No external URLs at runtime. Everything loads from this repo, with relative paths (the app lives under `/setlist-stand/`).
- Vendored libs in `vendor/`, exactly: pdf.js 3.11.174, pdf-lib 1.17.1, JSZip 3.10.1. Adding any other library, framework or build step needs Jonathan's OK.
- No music in the repo, ever. The repo is public.

## Layout
- `index.html`, `css/app.css`, `manifest.webmanifest`, `icons/`
- `js/`: `util`, `store` (IndexedDB), `library`, `setlists`, `viewer`, `ink`, `print`, `backup`, `main`
- `sw.js`: service worker; precaches every app file; has a `VERSION` constant
- `vendor/`: the three libraries
- `tools/`: `checks.mjs`, `smoke.mjs`, `msb_convert.py` (+ `README.md`)
- `tests/fixtures/`: small text-only PDFs for the smoke test
- `docs/`: `DECISIONS.md`. Root: `README.md`, `CHANGELOG.md`

## Data model (as of v1 part 1)
- IndexedDB `setlist-stand`, version 1, stores `songs`, `files`, `sets`, `ink` (in-memory fallback if storage is blocked).
- Song `{id, title, pages, added}`. The converter also writes `song`, `artist`, `version`, `file`. PDF bytes live in `files`, keyed by song id.
- Set `{id, name, songs:[songIds], created}`.
- Ink is keyed `songId:pageNumber`, a list of strokes `{t:'pen'|'hl', c:'#rrggbb', w:<fraction of page width>, p:[[x,y],...]}`. x and y are fractions (0 to 1) of the full page. Keep them that way.
- Backup is a zip: `library.json` `{app:'setlist-stand', version:1, ...}` plus `files/<id>.pdf`. Old backups and converter output must keep restoring.

## Checks
- `node tools/checks.mjs`: syntax of `js/*.js` and `sw.js`; every precached file exists and every app file is precached; no `http(s)://` in app code; no `window.claude`; `VERSION` in `sw.js` changed if a precached file changed.
- `node tools/checks.mjs --bump`: writes a new `sw.js` VERSION.
- `node tools/smoke.mjs`: Playwright run at 1280x800 (add, open, page turns, draw, reload, offline reload, setlist, print, backup/restore).

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
