# Moving your MobileSheets library into Setlist Stand

`msb_convert.py` turns a MobileSheets backup (`.msb` file) into a backup zip that Setlist Stand can restore. Your songs, setlists and pen/highlighter marks come across.

## Run it

You need Python 3 on your computer. In Terminal, in this folder:

1. Once only: `pip3 install pypdf` (GitHub installs `pypdf==6.21.4` in `.github/workflows/browser.yml`)
2. Then one command (use your own backup's file name):

```
python3 tools/msb_convert.py MobileSheets_YYYY-MM-DD.msb setlist-stand-from-mobilesheets.zip
```

## What it prints

A short report when it finishes:

- `songs`, `setlists` and `annotated_pages`: how many songs, setlists and pages with marks it converted.
- `skipped`: entries with no PDF (for example "Set 2" placeholders). They are left out.
- `trimmed`: songs where only some pages of the PDF were used; the extra pages are dropped.
- `textboxes` and `stamps`: marks it found but could not convert yet. Text boxes and stamps are not carried over.

## Load it into the app

1. Get `setlist-stand-from-mobilesheets.zip` onto your tablet (Drive, AirDrop, email, USB).
2. Open Setlist Stand, go to the Library, tap **Restore from backup**, and pick the zip.

## Keep your music private

This repo is public. Never commit the `.msb` file, the zip, or any PDF. Keep them in your own folder outside the repo (`.gitignore` also blocks them).

## Browser tests in Safari's engine (WebKit)

The browser tests use Chromium. To run them in WebKit (the engine behind Safari on the iPad):

1. Once only: `node node_modules/playwright/cli.js install webkit` (about 90 MB).
2. Add `SS_BROWSER=webkit` to the usual command, for example `SS_BROWSER=webkit node tools/smoke.mjs` or `SS_BROWSER=webkit node tools/loops.mjs --only roundtrip`. Unset, nothing changes (Chromium). The one-browser-at-a-time rule still applies.

What is different under WebKit (all in `tools/loops/browser.mjs` and `tools/loops/harness.mjs`):

- Each browser context is a persistent profile in the temp folder (deleted when it closes). A normal Playwright WebKit context is private, and a private WebKit session cannot store a PDF (a Blob) in IndexedDB, so no song could be added.
- The test wipe deletes the database from a bare page (`css/app.css`): the app keeps it open, and WebKit drops a delete that was blocked when the page then reloads.
- Skipped, with a one-line `SKIP ... (WebKit: ...)` message and a list at the end of the run: smoke steps 16 and 17 (touch drag; Playwright's WebKit can tap but not drag with a finger), and the loops that use Chromium's DevTools protocol to count reloads or slow the network (`update`, `kill switch`, `offline h`).
- Known difference, not hidden: `hygiene: dialogs trap focus...` fails under WebKit, because Safari's Tab skips buttons and checkboxes unless the user turns that on (the dialog code in `js/util.js` only wraps focus at the ends).
