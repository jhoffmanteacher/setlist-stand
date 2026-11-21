# Changelog

## 2026-11-21: Text notes, Crop and messages now work in full screen
- **Fixed: tapping Text in full screen froze the app.** The note box was opening where it could not be seen, with the music behind it locked, so nothing seemed to respond. The note box, the Crop screen and the little messages ("Fingers draw...", "Saved", and so on) now all show on top of the music in full screen and work as they do outside it.
- Leaving full screen while a box is open leaves the box on the screen and working.

## 2026-11-21: A privacy page
- **Privacy policy** at `privacy.html` (https://jhoffmanteacher.github.io/setlist-stand/privacy.html): says in plain words that your music and marks stay on your tablet, that the app has no accounts, ads or tracking, and what the optional Google Drive connection will and will not touch. It is a separate page; the app itself is unchanged and no update banner appears.

## 2026-11-20: Import a share package
- **Import a share package** (Library, after Share songs): pick the file someone sent you. A box lists the new songs and the setlist it will add, and asks before it adds anything.
- **Songs you already have are not added twice**, and they stay exactly as you have them (your own title, artist, version and crop). New songs arrive with the sender's titles, artists, versions and crops, and without any pen marks. A setlist always comes in as a new setlist (if you already have one with that name, it is called "<name> (2)"); nothing is ever replaced.
- **All or nothing:** a damaged file, a PDF that does not match, something the app cannot read, or a full tablet adds nothing and says why in plain words. A bad crop in someone's package is left out and the rest is kept.
- A file with far more entries in it than any package has (or marked as a huge zip) is refused before it is opened ("That package has too many files in it."; a file with padding after its end gets "That file is not a Setlist Stand share package."), and a package whose description part is damaged is caught even though the zip's own check is off.
- **One import at a time:** picking a second package while the first is still reading or saving is turned away ("An import is still running"), so nothing is added twice. A box says "Adding songs" while the package is saved, and Cancel on the reading box really stops the reading. The question shows the name the setlist will get ("Gig (2)" if you already have "Gig").
- Restore from backup and Import now tell you if you picked the wrong kind of file.

## 2026-11-20: Share songs or a setlist as one file
- **Share songs** (Library, next to Split a songbook): tick songs and it makes one file, `Songs - Setlist Stand share.zip`, with their PDFs, titles, artists, versions and crops. Songs marked archived are listed and can be shared too.
- **Share** on a setlist: one file with every song the setlist uses (each once, archived ones included), the order, and the breaks.
- Your pen marks and text notes are never in the file. Your own library is not changed by sharing. The file is saved to your downloads; where the browser lets the tablet send it directly, a **Share…** button appears too.
- The other person can't open these files yet: **Import a share package** comes in the next update.

## 2026-11-20: Split a songbook into songs
- **Split a songbook** (Library, next to Add PDFs): pick one big PDF (a fake book or songbook) and it becomes separate songs, each its own PDF in your library. The songbook itself is not kept; only the songs you add.
- **Bookmarks do the first pass.** If the PDF has bookmarks, every song bookmark is listed with its pages (a section like "Part One" is not listed as a song; Cover, Contents and Index start unticked). With no bookmarks, the book's pages show as small pictures: tap the first page of each song and type its title.
- **Fix anything before you add:** untick what is not a song, edit titles, first page and last page (the last page follows the next song unless you type one), or tap **Remove**. Two songs can share a page (use Crop to hide the other). One box sets an artist for every song whose title has none, and "Bigger pages" makes the pictures easier to read.
- **Titles are taken as you type them:** "Song (version) - Artist" in the title box fills in the artist and version; nothing else is rewritten.
- **Safe to repeat:** splitting the same book again skips songs already in your library ("Skipped N already in your library"); tick "Add a song again" to add them anyway. Two songs on one page are both added. If the tablet fills up part-way, the songs already added are complete, a message says how many were not, and the screen stays open with the rest still ticked so you can try again.
- **Not for protected books:** a restricted or password-locked songbook, one that hides layers or content (such as an answers layer), or one with a damaged page list is refused with a plain message (you can still add the whole book with Add PDFs).
- **Marking is never lost by accident:** Cancel asks for a second tap once you have made changes, and an app update never reloads the app while you are marking a book.
- Behind the scenes: links and other pointers inside a songbook are not copied into the songs (they would drag the rest of the book along), a song that still would hold other pages of the book is refused rather than saved (the other songs are still added), a book that makes every song as heavy as the whole book (some books keep one list of every picture for all pages) stops the run with a plain message instead of filling the tablet (a run may write up to 150 MB, or three times the book if that is more), and the songs start with no pen marks, crops or notes of yours.

## 2026-11-20: Screen-on button, protected charts print, Safari checked
- **Screen-on button:** a sun button in the song's top bar shows whether the tablet is being kept awake. Tap it to let the screen dim or keep it on (it remembers). If the tablet refuses (older iPads), the button shows a "may dim" warning and the app says once to set Auto-Lock to Never in Settings.
- **Protected charts print:** password-locked charts (many purchased PDFs) now print as pictures, with your pen marks, notes and crop in the right place, instead of being left out. The print dialog says the text won't be selectable and the file is bigger; "Print without them" and "Cancel" are still there. A chart that needs a real password to open is listed and left out.
- **Safari checked:** the whole walkthrough now also runs in Safari's engine (WebKit). Findings fixed: the Tab key inside dialogs now stays inside them when you use a keyboard; a private Safari window now says it can't save files instead of a generic error; a "tablet is full" error is no longer hidden behind a generic one.

## 2026-11-20: Tougher against bad files, bad updates and stray taps
- **The update note stays out of your way:** "Updated. Tap to reload" is hidden while a song is on screen and appears when you go Back, so a stray tap in the middle of a song can't reload the app.
- **Emergency off switch:** if a bad update ever reaches the tablets, `BREAK-GLASS.md` explains how to switch the app's saved copy off and reload it from the web. It never touches your library.
- **Pen marks stay on the right song:** turning a page while the pen is down no longer moves the stroke onto another page or song, and a damaged mark can't stop a setlist from printing.
- **Locked PDFs:** printing now names any password-protected chart and offers "Print without them", instead of printing blank pages for it.
- **Backups always restore:** each chart's checksum is taken from the PDF actually stored; a song whose PDF is missing is left out of the backup and the app tells you. A backup with something it can't read (a crafted name or id, an oversized list) is refused before anything is changed, and a damaged annotation page can no longer break later backups.
- **Delete and Replace PDF are all or nothing,** and a save the browser cancels no longer leaves the app waiting forever.
- **Restoring a backup that marks a song as deleted** now removes that song's PDF and marks on this tablet too, unless the copy on this tablet was changed after the song was deleted (then it is kept). A restored song brings back the backup's marks and clears any later ones on this tablet, so a chart and its marks always match. Names and titles stop at 200 characters.
- **A stuck pen can't lock the app:** if a stroke never gets its "pen up" (you switched apps mid-stroke), page turns work again after 3 seconds and the stroke is saved on its own page. Undo and Clear wait while the pen is down.
- **Names:** "War Pigs - Black Sabbath (1).pdf" (a file downloaded twice) is read as War Pigs by Black Sabbath, not swapped; extra spaces no longer change the sort order.
- **Replace PDF keeps the song's crop** (the message says so; "Reset" in the crop screen clears it).
- **Updates install the newest files** even when two deploys land within ten minutes, and an update that was already downloading when the app opened still shows its note.
- **Older tablets:** colours now have a fallback for iPadOS 16 to 17.4 and older Chrome, so dialogs stay readable. Supported: iPadOS 16 or newer, Android Chrome 100 or newer.
- **Smaller fixes:** Enter on Cancel in "Edit song" no longer saves; undoing a mark after leaving its song keeps the deletion; a setlist drag that is interrupted by a refresh stops cleanly.
- MobileSheets conversion: marks keep stable ids, the real page count is used, any page order is read, and a song with no readable PDF is reported instead of becoming a break.

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
