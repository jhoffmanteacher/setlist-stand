# Setlist Stand — scope and decisions

Running list of what the app must do. Source for the work orders.

## Users
- One person per library. No shared libraries. Each user's songs, setlists and annotations sync across their own tablets through their own Google Drive.
- Others get music through **share packages** (see below), never a shared folder.

## Platform
- Web app installed from the browser (PWA), hosted on GitHub Pages. Android and iPad.
- Must work fully offline: app files, PDF libraries and every chart stored on the tablet. Sync only when online.
- Sync: Google Drive with the `drive.file` permission only. The app sees its own "Setlist Stand" folder and files picked in Google's picker, nothing else.
- Repo: `jhoffmanteacher/setlist-stand` (public), code only — no PDFs in the repo.

## Must have
- Library of PDF charts; full-screen viewer; tap and swipe page turns; two pages side by side in landscape
- Each song is its own PDF file
- **Naming convention, title first**: `Song Title (version) - Artist.pdf` — e.g. "War Pigs - Black Sabbath.pdf", "Flowers in the Ashes (in G).pdf". Song, artist and version are separate fields; the library shows the song title first. Drive file names follow the same pattern.
- Annotation (pen, highlighter, eraser, undo), stored apart from the PDF
- **Text annotations** (MobileSheets library has 12 text boxes to carry over)
- **Annotations belong to the user, not the tablet**: the same person sees the same marks on their Android and their iPad
- Setlists with **drag-and-drop ordering** (drag handle only, no arrows)
- **Duplicate setlist**
- **Breaks** inside a setlist; while playing, a break shows a full-screen break page with its name and the next song
- **Crop** margins, with a choice of one crop for the whole song or a crop per page
- **Split import**: one big PDF (songbook/fake book) becomes separate songs, using the PDF's bookmarks when present and hand-marked page ranges
- **Replace chart**: swap in a corrected PDF; annotations start fresh
- **Archive songs**: hidden from the library, still shown and playable in old setlists
- Print a setlist as one combined PDF (annotations optional); cropped songs print cropped
- Back up everything to one .zip; restore from it
- **Share package**: export chosen songs or a whole setlist as one file with the PDFs and setlist order but **no annotations**; another user imports it into their own library. Songs already in their library are matched and not added twice.

## Not doing
- Collections (setlists cover it)

## Later
- Bluetooth page-turner pedal (no pedal yet)

## Work orders
- WO1 `WORK-ORDER-setlist-stand-v1.md` (2026-11-19): app online and offline (PWA on GitHub Pages), song details / archive / replace chart, drag-and-drop setlists with breaks and duplicate, crop and text notes.
- Later work orders: Google Drive sync, songbook split import, share packages, page-turner pedal.

## Moving from MobileSheets (2026-11-19)
- Backup `MobileSheets_2026-11-18.msb` decoded. Converter: `tools/msb_convert.py` (format notes at its top). Output restores straight into the app and applies the naming convention (artist pulled from "Artist - Title - Chords" names; "- Chords", "- Pro", "(1)" dropped; versions like OLD/2/in G moved into parentheses).
- Library: 74 songs (all PDFs intact), 13 setlists.
- Annotations live in MobileSheets' database, not the PDFs. 40 pages carry marks: pen strokes and lines convert and line up with the music.
- Not converted yet (WO1 adds them): 12 text boxes, crops (87 page crops across 55 songs). 1 stamp is not converted.
- "Set 2" / "Set 3" are placeholder songs with no file, used as set breaks in setlists → WO1 maps them to Breaks.
- One song ("If It Takes A Lifetime - Chords 2") used only pages 1–2 of a 3-page PDF; the converter trims it.

## Technical notes
- Same user on two tablets: save each stroke with its own id and merge by id when syncing (deleted strokes kept as markers), so marks made on both tablets offline are never lost.
- Duplicate matching on import: fingerprint each PDF file's contents.
- MobileSheets setlist order = SetlistSong row order (no position column).

## Open questions
- Share package: include crop settings and song details (title, key), or PDFs only?
