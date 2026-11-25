# Changelog

## 2026-11-24: The app checks its own stored files
- Setlist Stand now checks every file of its offline copy before it uses it. Other websites on the same address (the guitar and English Intensive sites) share the place where the offline copy is kept, so a mistake in one of them could have put its own code into this app. A changed or damaged file is now thrown out and never run; the real one is fetched again the next time the app is online. Nothing new appears on screen. Library → Problem log (it shows once it has a line) names a file that was thrown out.
- With no internet, a file that fails the check is missing until the app has been online once, so the app may not open until then. Open it with internet and leave it on the Library for a minute. This is the same fix as when another site deletes the offline copy.
- Safety checks: the app may now send data only to the two Google Drive addresses it uses, not to every address on Google's data host. Nothing changes in how Back up / Sync works.
- Safety checks: the PDF reader's two guards against a booby-trapped PDF (the page policy and the "no eval" setting on every open) are now pinned by a check and a test, so a later change cannot remove one by accident.
- Safety checks: the list of correct fingerprints is made together with the version number (`node tools/checks.mjs --bump`) and checked on every push; eight new tests change the offline copy the way another site could and watch what the app does, in Chrome and Safari's engine.

## 2026-11-23: Review fixes and gig helpers
- **A chart that will not open no longer blocks the setlist.** It shows "This chart could not be opened. Your music is safe." and the page turns move past it, both ways.
- **Remove in a setlist has Undo** for 6 seconds. A quick double tap on Add no longer removes a song behind the box.
- **Ready check** (setlist More menu): opens every chart with no internet and says which are fine, missing or will not open. The Library says "Works offline." when the offline copy is complete. If the app does not start, a box says so and offers Reload.
- **Go to a song:** tap the song's name in a setlist to jump to another song. **Add to setlist...** is in a song's ⋯ menu. A setlist dated today shows "Tonight" with Play on both screens. Delete song names the setlists it is in and offers Archive instead.
- Copy song refuses a version name another copy already has; Edit song keeps the box open when the title is emptied; searching a picker for an archived song says so; undo stays with the song on screen; a long press is not a page turn; held keys turn one page.
- Download PDF names a song it had to leave out and prints a bad colour black; page boxes are read like the viewer reads them.
- Backup files are named with your local date and time. A backup with marks that cannot be drawn restores without them (and says how many). A long setlist name no longer makes a share package refuse. The sync report says which songs now play the chart from your other tablet.
- Safety checks: the start-up files are checked as the browser runs them; the offline refill re-checks the version after it downloads.

## 2026-11-23: Archived songs stay out of the song pickers
- The box where you tick songs (Add songs to a setlist, Add songs to a collection, Share songs) no longer lists archived songs. If you have any, a **Show archived** box appears; tick it to see them (marked "(archived)") and add them. A song you ticked stays ticked if you hide archived again.
- Setlists could not take archived songs before; now they can, through that box.

## 2026-11-23: Setlist Stand fits a phone
- Setlist Stand now fits a phone: every box keeps its heading and buttons on screen (the rest scrolls), the Library's header is shorter, the collections slide sideways with the Collections button always in view, the A to Z strip never crowds its letters (fewer letters with a dot between, or it waits until you scroll), and messages use the whole width.
- A setlist's row has Play and one ⋯ button (Duplicate, Delete), like a song row. Delete asks "Delete <name>? Its songs stay in your library."

## 2026-11-23: Restore asks first and keeps what it replaces
- **Restore from backup** now tells you first, in plain words, what it will change: what it adds, puts back, deletes and leaves alone. Cancel changes nothing. An empty tablet is not asked.
- **Nothing is thrown away:** any chart or marks the restore would replace or delete go to Archived as "(before restore DATE)", and a setlist you changed since the backup is kept as "<name> (before restore)", still playing what it played.
- If a chart on the tablet cannot be read, the question says so and the restore still goes ahead. If the copies would be too big to keep, it offers "Restore without keeping copies" (two taps).

## 2026-11-23: A to Z strip and a song count
- The Library shows how many songs you have ("74 songs", or "3 of 74 songs" while you search or look at one collection).
- With 30 or more songs, a strip of letters appears along the right edge: tap a letter, or slide your finger along the strip, to jump to the songs that start with it. Letters with no songs are dimmed.

## 2026-11-23: Updates that cannot get stuck
- Setlist Stand now shows "Updated. Tap to reload" even if an update leaves the app blank, so a bad update can always be replaced by the next good one.
- Left open, the app finds a new version by itself within about an hour (never during a song, and the banner waits while a box is open).
- If another website on the same address deleted the app's offline files, it quietly rebuilds them the next time it is on screen with internet. Leave it open on the Library for a minute.

## 2026-11-23: A backup copy in your Google Drive, and a sync reminder
- **Backup copy:** when a sync finishes, the app now also saves a full backup of your library in a "Backups" folder in your Google Drive, about once a week, and keeps the last four (older ones go to the Drive bin). If Drive is full or you press Stop, only the copy is skipped and the sync still finishes. A copy saved this way counts as a backup, so "Changes since your last backup" goes quiet until you change something. To use one: download the zip in the Drive app first, then Restore from backup.
- **Sync reminder:** if you have not synced for a week or more, the reminder line says "Last synced 9 days ago." with a Sync button. The app never contacts Google by itself: this is worked out from the date alone.

## 2026-11-23: A save that fails says so
- If the tablet is full (or the browser refuses to save), editing a song, archiving it, changing a setlist, reordering it or cropping now says so in plain words and leaves everything exactly as it was.
- Tapping Remove, Add break or Duplicate twice in a hurry now does it only once.

## 2026-11-23: Safer restore, and very long names are cut
- **Restore:** a file built to unpack into far more than it claims is refused with a plain message, instead of filling the tablet's memory. Nothing changes on the tablet when that happens. A backup over 1.5 GB is refused as too big to open.
- **Long names:** song, artist and version names longer than 200 letters are cut when they are made (a very long file name, Copy song, Edit song, an old backup), and a share package or chart update file with a long name is added with the name cut instead of being refused.

## 2026-11-23: A mark can no longer land on the wrong song
- While the next song is still appearing, drawing with the pen or tapping Clear now does nothing, so a mark can no longer land on the wrong song (it used to be saved on the new song, at the old page number).

## 2026-11-23: One ⋯ button per song, no Test connection
- Each song in the Library has one **⋯** button for Edit, Copy, New version, Archive and Delete (Restore and Delete in Archived), so long titles fit: on an iPad held upright the title gets about twice the room. Delete asks "Delete <title>?" before it deletes anything.
- The Google Drive box no longer has **Test connection**; Sync does the real job.

## 2026-11-23: Import chart updates
- **Import chart updates:** Share / Import → Import chart updates takes one file of cleaned-up charts from Claude and gives each song its new chart, like New version: same place in every setlist, the old chart and its marks kept in Archived. You see the list first and can untick any song.
- The list also shows charts that are already up to date, a chart for a song it cannot find (you can tick it to add it as a new song), and anything worth a second look ("Matched by name", "In the file: …", "This PDF is also in your library as …"). Apply saves everything ticked in one go, or nothing.

## 2026-11-22: New version clears the crop
- When you bring in a **New version** of a chart, the song's crop is now cleared, because the old margins rarely fit the new file. The old chart in Archived keeps its crop. The message says when a crop was cleared.

## 2026-11-22: Import a setlist from a text file
- On the Setlists list, **Import from a text file** reads a plain text file with one song per line (numbers and bullets at the start are ignored; a line that says Break or `---` becomes a break). A box shows what was found, lets you pick when two songs match, and says which lines have no song in your Library. Tap **Add** and the setlist is made, named after the file. Nothing in your Library changes, and no song is made from a line.

## 2026-11-22: The back swipe closes the open song, not the app
- With a song open, the Android back gesture (and the iPad edge swipe) now takes you back **one step at a time**: a message box first, then the Crop screen, then Annotate, then the song itself, back to the list you opened it from. From the list, back leaves the app as it always did.
- Opening, closing and turning pages do not pile up history, and an update reload does not trap you in the app.

## 2026-11-22: Your pen marks and notes now follow you between tablets
- **Marks in Sync:** tap **Sync** and the pen, highlighter and text notes on every page go to your own Google Drive and to your other tablet, along with your songs, setlists and collections. Draw on the same page on both tablets and both sets of marks are kept. An erase or an edit on one tablet reaches the other.
- **The report** says how many pages of marks were sent and received. A page that cannot be used (damaged, or too big) is listed by song and page, and the rest still syncs.
- **A chart you replaced with New version** keeps its old marks on the archived copy, on both tablets; the new chart starts clean. Marks never move onto a different chart.
- Sync is still only when you tap it. If you restore an older backup after syncing, the next Sync brings back what your other tablet changed since: disconnect Google Drive first (see BREAK-GLASS.md, "Sync did something wrong").
- Fixed on the iPad: after a box opened from the Google Drive box is cancelled, focus now returns to the Google Drive box.

## 2026-11-22: A More menu on an open setlist
- An open setlist now shows Play setlist, Add songs, Add break and **More**. Gig date, Download PDF, Share, Duplicate, Rename and Collections are in the More menu, each with a short line saying what it does. Download PDF and Share are greyed when the setlist has no songs.
- Nothing about how any of them works has changed.

## 2026-11-22: Gig-date fill-in waits for a sync
- **Fill in gig dates after a sync:** if you use Google Drive, the offer to fill in gig dates from setlist names now comes only right after a sync (within 10 minutes of one). Before, a tablet that had not synced for a while could fill in a date on an out-of-date copy of a setlist, and a later sync could then put that old copy over a newer one from your other tablet. If you never use Drive, nothing changes.

## 2026-11-22: Two menus on the Library
- **Share / Import:** Split a songbook, Import a share package and Share songs are now in one menu, under the search box.
- **Back up / Sync:** Back up everything, Restore from backup and everything for Google Drive (Sync, Test connection, Connect, Disconnect) are in one menu too. The bottom of the Library now keeps only Show archived, one line about Google Drive and the storage lines. The reminder at the top still has its own Back up now and Sync buttons.
- Nothing about how any of these work has changed.

## 2026-11-22: Gig dates on setlists
- **Gig dates:** each setlist can have a gig date. Set it when you make the setlist, or with the new **Gig date** button on an open setlist (you can change or clear it there). The date shows under the setlist's name, and in the list before the song count. The Setlists list now shows upcoming gigs first, then this year's past gigs, then setlists with no date; earlier years are folded away until you tap their year. With no dated setlists the list looks as it always did.
- **Names that already hold a date:** the first time you open Setlists after this update, setlists whose name clearly holds a full date (like "Sf October 18 2026") are offered as gig dates, each with a tick box. Nothing is filled in unless you tap **Fill in**, and names never change. Names with no year, no day, or a day that does not exist ("February 31") are left alone.
- **Download setlists:** the **Print PDF** button on a setlist is now **Download PDF** (it always saved a file): one PDF of the setlist's songs in order, with your marks if you leave them ticked, named with the gig date when there is one. In the Setlists list, **Download all** saves one zip file with every chart of the setlists in the collection you are looking at (or all your setlists), including the folded-away years, each chart once, and a short list of songs for each setlist (the charts are saved as they are, without your marks). Setlists with no songs are skipped, a song with no PDF on the tablet is named at the end, and Stop downloads nothing.
- **Backups and sharing:** a backup carries the dates. A share package does not (a setlist you import has no date). Duplicate does not copy the date either.

## 2026-11-22: Sync your songs and setlists between your tablets
- **Sync button.** In the Library, tap **Sync**. It sends what you changed on this tablet to your own Google Drive and brings down what you changed on your other tablet: songs (details, crop, archive, and the PDF itself), setlists and collections. Pen marks and text notes do not sync yet; they are the next step.
- **Only when you tap.** Nothing syncs by itself. After you close or reload the app you sign in to Google again when you tap Sync (the sign-in is not kept on the tablet).
- **If you changed the same thing on both tablets,** the newer change is kept and the report names it ("changed on both tablets"). A chart is never lost: if a sync would replace a chart with a different one, the old chart and its marks are kept in Archived.
- **Deleted on your other tablet?** The app lists what was deleted there and asks: **Delete here** (two taps) or **Keep**. Nothing is deleted here until you tap, and a missing file in Drive never deletes anything. A kept song goes back to your other tablet, but not back into the setlists it was taken out of.
- **A report that stays until you tap OK:** what was sent and got, what changed on both tablets, and anything it skipped, by name, with the reason. Stop works at any time; what was done before is kept and nothing is half saved.
- **The reminder line** now also says "Changes since your last sync" with a Sync button. Sync is not a backup: it never clears the backup reminder, and a mistake syncs to your other tablet too. The first time, a short note says so and says to restore a backup on your second tablet before its first sync, so your songs match instead of doubling.
- **Drive folder:** renaming the "Setlist Stand" folder in Google Drive is harmless now: the app finds its folder by a private mark, not by its name.
- **Small fixes:** a damaged crop no longer shows a blank page, and a crop saved on a song that came from a restore no longer stops with an error.

## 2026-11-21: Faster turns into charts that are big photos
- **Faster turns into photo charts:** charts that are scanned photos now turn as quickly as the others. The app used to start getting the next song ready only when you reached the last page of a song; a big photo page takes about four times as long to draw as a text page, so turning straight on from the last page waited. It now starts one page earlier. Nothing is stored in a smaller size and the pages are as sharp as before.

## 2026-11-21: A backup reminder after you change something
- **Backup reminder:** the app now reminds you to back up when you have changed something since your last backup, instead of after 14 days. It says "Changes since your last backup (today)." with a **Back up now** button, on both Library and Setlists, and it appears as soon as you save a change (a mark, a rename, a new setlist...). After a backup it goes away. It never shows while you are playing a song.
- A restored library counts as backed up until your next change. If you have songs and have never backed up, it still says "You have not backed up yet."

## 2026-11-21: Add songs to a setlist in the order you tap them
- **Add songs in order:** in a setlist, tap songs in the order you want them. Each one gets a number, and they are added to the setlist in that order. Tap a numbered song again to take it off; the ones after it move up. The button says how many ("Add 3").
- **Search box:** every song list (Add songs, Share songs, Add songs to a collection) has a search box at the top. Songs you have already picked keep their number while the search hides them. The on-screen keyboard does not pop up until you tap the search box.

## 2026-11-21: Collections: one for each band
- **Collections:** the Library and Setlists now have a row of buttons under the tabs: **All**, one button for each collection, and **Collections**. A collection is a group you name yourself, like "Friday Band" or "Jazz Trio". Tap one and both tabs show only that band's songs and setlists. Your choice stays when you switch between Library and Setlists.
- **Make and manage them:** tap **Collections** to make a new one, rename it, add songs to it, or delete it. Deleting a collection (two taps) never deletes a song, a PDF, your marks or a setlist: they just leave that collection.
- **Put songs and setlists in them:** **Edit** on a song has tick boxes for its collections, and an open setlist has a **Collections** button. A song or setlist can be in several at once. **Add songs** in a setlist lists the shown collection's songs, with a **Show all songs** switch for the rest.
- **A default:** in the Collections box, **Set as default** makes the app open on that band, and new songs and setlists join it. (Tap Default again to clear it.) Anything new joins the collection you are looking at; with All showing, it joins the default.
- Copy a song keeps its collections. A setlist you duplicate stays in the same collections. Share packages carry no collections: songs and a setlist you import join the collection you are looking at, and a song you already had stays exactly as it was.
- **Safe update:** your library is updated the first time the new version opens; every song, PDF, mark and setlist is kept as it was. Backups now hold your collections (and older backups still restore). If the app is also open in another tab, the page says "Close the other Setlist Stand tab" and carries on by itself when you do.

## 2026-11-21: Copy a song to make a second version
- **Copy:** each song in the Library has a new **Copy** button. Tap it, type a name for the new version (for example "for the wedding band") and Save. The copy is its own song with the same chart, the same details and crop, and **the same pen marks and text notes** as the original.
- Marking up the copy never changes the original, and the other way round. Setlists keep using the original: the copy is in no setlist until you add it.
- The version name has to be different from the original's. A full tablet saves nothing and says so.

## 2026-11-21: Connect the app to your Google Drive (nothing is copied yet)
- **Connect Google Drive:** the Library has a new "Connect Google Drive" button. It takes you to Google to sign in and to let Setlist Stand use its own folder in your Drive, then brings you back to the app. The app can see only the files it makes itself, never the rest of your Drive.
- **Test connection:** makes (or finds) a folder called "Setlist Stand" in your Drive and says how many files are in it. This is only a first step: your songs, setlists and marks are not copied anywhere yet, and nothing in your library changes.
- **Sign-in lasts about an hour.** After that the Library says "Your Google sign-in ran out" and "Connect again" does it again in two taps. **Disconnect** makes this tablet forget the sign-in (your Drive is not touched).
- **Plain messages:** no internet, Google busy, Drive full, sign-in refused or taking too long: each says what happened in plain words and changes nothing. Cancel works at every step.
- **Gigs are unaffected:** the app never talks to Google unless you tap one of these buttons, so it still works fully offline.

## 2026-11-21: Fixes from the iPad playtest
- **The stylus draws without tapping Annotate.** With Annotate off, a stylus draws with the pen (or the highlighter, if that was chosen last); a finger still only turns pages. Tap Annotate for Undo, colours, thickness, the eraser and Text. A hint says so the first time.
- **Text notes with a finger:** a finger tap is ignored while annotating unless "Finger draws" is on, so a tap with Text chosen seemed to do nothing. It now says: tap "Finger draws" first.
- **One thickness button.** The three thickness buttons are now one button that opens the three choices. It stays in the same place, dimmed when the highlighter, eraser or Text is chosen, so the other buttons no longer jump around.
- **No Full screen button in the Home Screen app.** The browser refuses it there (the app already fills the screen), so the button only said "not available". It still shows in a Safari tab and on Android.

## 2026-11-21: New version keeps the old chart
- **Replace PDF is now New version.** Pick the new PDF and the song takes it: it keeps its place in every setlist and its crop, and starts with fresh marks. Nothing is thrown away any more: the chart it had, with its pen marks and text notes, is kept in **Archived** as "Song (old 2026-11-21) - Artist".
- One question comes first ("Use ... as the new version of ...? The current chart and its marks move to Archived.") and then everything is saved in one step, or not at all. Cancel changes nothing.
- If the current chart cannot be read, nothing is changed. If the song was edited or deleted on the other screen while the question was open, nothing is changed either.
- While a big PDF is read, a "Reading..." box is up so the song cannot be opened half-way.

## 2026-11-21: The library is in A to Z order by song name
- **A to Z by song name:** the Library, the Archived list, your search results, and the lists you pick songs from ("Add songs" on a setlist, "Share songs") are all in A to Z order by the song's name. Upper and lower case and accents do not matter, and numbers count as numbers ("2 Fast" comes before "10 Years Gone").
- **Every word counts:** "The Weight" is under T and "A Hard Day's Night" is under A. Before, a leading "The", "A" or "An" was ignored.
- Two songs with the same name go by artist, then version.
- The order of songs inside a setlist is still yours: drag them wherever you like.

## 2026-11-21: Restore and Back up show what they are doing, and can be stopped before anything changes
- **Restore from backup** now opens a box right away: "Opening the backup…", then "Checking song 12 of 74…", then "Saving to this tablet…". It no longer looks as if the app has hung.
- **Stop** works while Restore is only reading and checking. It leaves everything as it was and says "Restore stopped. Nothing was changed." Once the library starts to be saved, the Stop button goes away, because that last step is all or nothing.
- **Back up everything** shows "Packing song 12 of 74…" and then "Making the backup file… 45%". **Stop** works at any point: nothing is downloaded, and the "last backup" reminder is not changed.
- A long message (say, why a backup could not be restored) now stays on screen long enough to read.
- The "Updated. Tap to reload" button is out of reach while one of these boxes is open, so a stray tap cannot throw away a restore.

## 2026-11-21: Pages turn faster, and the next song in a setlist is ready before you get to it
- **Page turns:** turning forward or back a page now shows the next page straight away. The page on either side is drawn ahead.
- **Next song in a setlist:** while the last page of a song is showing (or a break page), the next song is opened and its first page drawn, so the turn into it takes no waiting. Going back into the previous song works the same way, and so does the song after a break.
- **Memory:** the app keeps a limited number of drawn pages (by size, not only by count) and gives the memory back for the ones it drops, so it should stay steady on an iPad. A song opened ahead and not played is closed again.
- Page turns, break pages and Back behave as before.

## 2026-11-21: Three line thicknesses for the pens
- **Pen thickness:** when a pen is chosen, three small buttons next to the colours let you pick a thin, medium or thick line. Medium is the line the pen always drew. The app remembers your choice.
- The highlighter stays as it was, and so do all the marks you already made. Thin, medium and thick lines print as drawn.

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
