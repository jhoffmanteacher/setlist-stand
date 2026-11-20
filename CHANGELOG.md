# Changelog

## 2026-11-20: Safer for gigs
- **Backups you won't forget:** the Library nags (once) when you have never backed up or the last backup is more than two weeks old, with a "Back up now" button, and shows when the last backup was. A storage line shows how much space the app uses and warns when the tablet is nearly full or the browser may clear the app's data, with a button to ask the browser to protect it.
- **Restore is all or nothing.** A damaged backup, a missing PDF, a backup from a newer version of the app, a full tablet, or the page closing in the middle can no longer leave you with half a library. You get a plain message and nothing changes.
- **Updates no longer lose your place.** "Updated. Tap to reload" now puts you back on the song and page you were on; a second open tab is no longer forced to reload; a tab that has been open since the first install can update.
- **Printing rotated PDFs:** pen marks, notes and crops now land in the right place on pages that are rotated 90, 180 or 270 degrees.
- **Duplicates:** adding a PDF that is already in your library asks first (Skip them, or Add anyway).
- **Clear messages:** "The tablet is full" instead of a generic failure, and a private problem log (Library, bottom) that stays on the tablet.
- **Setlists by keyboard:** with a drag handle focused, the up and down arrow keys move the row.
- **Tablet feel:** no pull-to-refresh or rubber-banding while you play, no accidental text selection, no double-tap zoom delay, and the bars keep clear of the iPad's rounded corners and home indicator.
- **Security:** the app now declares a strict Content-Security-Policy (only its own files, no outside hosts, no `eval`).

## 2026-11-19: Crop margins and text notes
- **Crop** in the viewer's top bar opens the page with a box you drag by its edges and corners. **Crop this page** crops one page, **Crop whole song** crops every page the same way, and **Reset** removes the crop. A cropped page is drawn larger to fill the screen. Your pen marks never move when you change a crop.
- A cropped song prints cropped, with its annotations in the right place.
- **Text** tool in the annotation bar: tap the page, type, pick small, medium or large and a pen colour. Tap a note to edit or delete it, or drag it to move it. Notes undo like pen strokes, print, and are included in backups. The eraser leaves notes alone.
- MobileSheets conversion: your text notes (11 of 12; one was just a blank line) and your crops (97 cropped pages across 58 songs) now come across.

## 2026-11-19: Drag-and-drop setlists, breaks and duplicate
- Reorder a setlist by dragging the handle on the left of a row (finger, stylus or mouse). The list scrolls when you drag near the top or bottom. The up and down arrows are gone.
- **Add break** puts a break (named "Break") in the setlist. Tap its name to rename it, drag it like a song, or remove it.
- While playing, a break shows a full-screen page with its name and the next song. The next page turn goes on to that song, and going back shows the break again. The song before a break says "Next: <break name>".
- **Duplicate** copies a setlist as "<name> copy" and opens it.
- Printing a setlist skips breaks.
- MobileSheets conversion: the "Set 2" and "Set 3" placeholder songs now become breaks (10 breaks in 6 of your 13 setlists).

## 2026-11-19: Song details, archive and replace chart
- Each song now has a Title, Artist and Version. Tap **Edit** to change them. The library shows "Song (version) - Artist" and sorts by title, ignoring a leading "The" or "A".
- **Archive** hides a song from the library without touching your setlists: archived songs still show (with an "Archived" tag) and play in the setlists that use them. Turn on **Show archived** at the bottom of the library to see them and tap **Restore**.
- **Replace PDF** swaps in a corrected chart. The song keeps its place in every setlist; its annotations start fresh (you tap twice to confirm).
- Search finds a song by title, artist or version.
- Backups now use format version 2 and still restore older backups and the MobileSheets conversion.
- Converter: "Artist - Title - Chords" names no longer end up with a stray dash.

## 2026-11-19: Setlist Stand installs from the browser and works with no WiFi
- Open the app in Chrome (Android) or Safari (iPad) and add it to the home screen. It then opens like any other app.
- Your charts, setlists and annotations stay on the tablet. With no WiFi the whole app still opens and plays.
- When a newer version is ready, a small "Updated. Tap to reload" note appears.
- Printing a setlist on Android can also open the share sheet.
- Everything from the prototype still works: library, setlists, full-screen viewer with page turns, pen/highlighter/eraser, print, back up and restore.
