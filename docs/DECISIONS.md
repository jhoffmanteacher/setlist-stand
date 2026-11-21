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
- **Split import** (done, WO2): one big PDF (songbook/fake book) becomes separate songs, using the PDF's bookmarks when present and hand-marked page ranges
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
  - Part 1 (installable offline app): done 2026-11-19.
  - Part 2 (song details, archive, replace chart): done 2026-11-19.
  - Part 3 (drag-and-drop setlists, breaks, duplicate): done 2026-11-19. Converter turns MobileSheets "Set 2"/"Set 3" placeholders into breaks (10 breaks across 6 of the 13 setlists).
  - Part 4 (crop, text notes): done 2026-11-19. Converter carries over crops and text notes (see "Moving from MobileSheets").
- WO2 songbook split import (2026-11-20): done. Library → **Split a songbook**.
  - Bookmarks give the first list (only the lowest level: a section like "Part One" is not a song; Cover/Contents/Index start unticked). With no bookmarks, tap the first page of each song in the page pictures. Title, first page and last page are editable; the last page follows the next song unless typed. Two songs may share a page (crop the extra with Crop). A text box gives one artist for every song whose title names none.
  - Each song is a new PDF made from the book's pages (page size, rotation and boxes kept). Whatever on a page points at other pages (links, a note's page, form-field parents, buttons, article threads) is taken off the copy so it cannot pull the rest of the book in; notes and other marks that point nowhere stay. A song that still holds another page of the book is refused, never saved (the other songs of the run are still added). Nothing is taken out of a page (a song must never lose part of a chart). Instead a run may write at most the larger of 150 MB and three times the book; a book that makes every song as heavy as the whole book (one list of every picture for all its pages) stops the run after a few songs with a plain message, the rest stay ticked. A book whose weight is one big shared font is split normally (each song carries its copy) up to that budget. Pruning such books safely is a possible later job. The book itself is not stored. Same pages give the same bytes, so splitting a book again skips songs already in the library (two songs on one page both count: only the library as it was counts); "Add a song again" overrides.
  - Titles typed in the list are taken as typed ("Song (version) - Artist"); the old-file-name guessing is not applied.
  - If a run fails (say the tablet is full) or is stopped, the screen stays open with the songs not yet added still ticked, and a dialog says what was added and what was not.
  - Not done: a protected (restricted) songbook, one that hides layers by default or uses layer rules (OCMD), and one with a damaged page tree are refused with a plain message. Printing already renders protected charts as pictures; splitting could do the same later. A book's own layer settings are not carried into songs, which is why such books are refused.
  - Memory: the book is held in memory about three times over while the screen is open, so a very large book can fail on a tablet with little memory; nothing is changed when it does.
- WO3 share packages (2026-11-20, `WORK-ORDER-share-packages.md`): Part 1 done 2026-11-20 (Share songs in the Library, Share on a setlist; the file only, nothing imports it yet). A package carries the stored PDF bytes, song details (title, artist, version) and crops, and for a setlist its order and breaks; never annotations (crops and details: Jonathan, 2026-11-20). Part 2 (Import a share package) is next.
- Later work orders: Google Drive sync, page-turner pedal.

## Moving from MobileSheets (2026-11-19)
- Backup `MobileSheets_2026-11-18.msb` decoded. Converter: `tools/msb_convert.py` (format notes at its top). Output restores straight into the app and applies the naming convention (artist pulled from "Artist - Title - Chords" names; "- Chords", "- Pro", "(1)" dropped; versions like OLD/2/in G moved into parentheses).
- Library: 74 songs (all PDFs intact), 13 setlists, 41 pages with annotations (40 with strokes, 1 with only a text note). Converter naming fixed 2026-11-19 so "Artist - Title - Chords" no longer leaves a stray dash, and "Vancouver - Lyrics - Chords" becomes "Vancouver (lyrics)".
- Annotations live in MobileSheets' database, not the PDFs. 40 pages carry marks: pen strokes and lines convert and line up with the music.
- Converted in WO1 Part 4: text boxes (11 of 12; the twelfth was a single blank line) and crops (97 cropped pages in 58 songs: 20 songs get one song-wide crop, 38 songs get per-page crops). MobileSheets stores many all-zero or full-page crop rows meaning "no crop"; those are skipped. Not converted: 1 stamp, and text boxes' bold style.
- "Set 2" / "Set 3" are placeholder songs with no file, used as set breaks in setlists → converted to Breaks (done in WO1 Part 3).
- One song ("If It Takes A Lifetime - Chords 2") used only pages 1–2 of a 3-page PDF; the converter trims it.

## Technical notes
- Same user on two tablets: save each stroke with its own id and merge by id when syncing (deleted strokes kept as markers), so marks made on both tablets offline are never lost.
- Duplicate matching on import: fingerprint each PDF file's contents.
- MobileSheets setlist order = SetlistSong row order (no position column).
- Known limit: a share package holds every PDF in memory while it is built (about twice their total, like a backup), so a very large selection can fail on a tablet with little memory; nothing is changed when it does.
- Known limit: every song cut from a songbook carries its own copy of the fonts and images its pages use (pdf-lib copies what a page points at), so the songs together can take more space than the book did.
- Known limit: a restore holds the zip and every PDF in memory before it writes (about 3 times the zip's size), so a very large backup can fail on a tablet with little memory; nothing is changed when it does.

## Open questions
- None.
