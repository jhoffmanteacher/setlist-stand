# Break glass: when the app is broken at a gig

Plain steps for an emergency. Jonathan can say to a Claude session: "follow BREAK-GLASS.md, situation (a)".
Claude runs every command; Jonathan only answers questions and checks the tablet.
The app lives at https://jhoffmanteacher.github.io/setlist-stand/ and keeps a copy of itself on each tablet (the
"service worker"), so it opens without internet. That copy is what can get stuck.

## (a) The last push broke the site
Most problems. The fix is to undo the push; every tablet then updates as usual ("Updated. Tap to reload").
1. `git fetch` and `git log --oneline -5 origin/main`; find the commit that broke it (ask Jonathan if unsure).
2. `git revert --no-edit <sha>` (one revert per bad commit, newest first).
   **Never revert a commit that raised `DB_VERSION` in `js/store.js` (2026-11-21, Collections: version 2)** and never lower it: a
   tablet that has opened its library with the higher number cannot open it with a lower one, so the app would not see the library.
   Fix forward instead, or revert everything else and keep `DB_VERSION` and its stores. `node tools/checks.mjs` fails if it goes down.
3. If the revert conflicts ONLY on the `VERSION` line of `sw.js`: keep either side, `git add sw.js`,
   `git revert --continue`. Any other conflict: stop and ask. Never type a VERSION by hand.
4. `node tools/checks.mjs --bump`, then `node tools/checks.mjs` (all PASS), then commit the bump.
5. `git push origin HEAD:main`.
6. Confirm the deploy (Pages takes a few minutes):
   `node tools/loops.mjs --only live --live https://jhoffmanteacher.github.io/setlist-stand/ --wait 600`
7. On the tablet: open the app, tap "Updated. Tap to reload" when it appears. The banner comes from a small separate
   file (js/boot.js), so it appears even when the broken push left the app blank. An app left open finds the fix by
   itself within about an hour (while no song is open); opening it again finds it at once.
8. No banner at all (the broken push was js/boot.js or index.html itself): close the app completely (iPad: swipe it
   away in the app switcher; Android: close it from Recent apps; and close any browser tab with it), then open it again
   with internet. The fix takes over once no copy of the app is open. If even that does not help: situation (b).

## (b) Tablets are stuck on a broken copy that a normal update does not clear
Only when (a) did not help: the banner never comes, or tapping it still shows the broken app.
The kill switch (`tools/kill-switch/kill-sw.js`) replaces the offline copy with "always use the internet".
1. `cp tools/kill-switch/kill-sw.js sw.js`
2. `git commit -am "Break glass: kill switch armed" --no-verify` and `git push origin HEAD:main --no-verify`.
   `node tools/checks.mjs`, the git hooks and the GitHub test runs FAIL while the kill switch is `sw.js`
   (it has no file list and no VERSION). That is expected; `--no-verify` pushes anyway. Do not "fix" the checks.
3. Confirm it is live: `curl -s https://jhoffmanteacher.github.io/setlist-stand/sw.js | head -3` shows
   `KILL-SWITCH`. GitHub Pages may serve the old file for up to about 10 minutes; wait and try again.

What each tablet does:
- The browser checks `sw.js` the next time the app is opened (or reloaded). Allow up to ~10 minutes for Pages,
  then one open of the app.
- The kill switch deletes the app's offline copy and takes over. An open tab reloads ONCE by itself; a song
  that was open comes back on the same page.
- Nothing the musician saved is touched: songs, PDFs, setlists, markings and notes stay on the tablet.
- While it is armed the app needs the internet. It will NOT open offline. Do not go to a gig without Wi-Fi
  or data while it is armed: fix the real problem first and go back (below).

Going back (once the real problem is fixed in the code):
4. `git revert --no-edit <the "kill switch armed" commit>` (the real `sw.js` returns).
5. `node tools/checks.mjs --bump`, then the full `node tools/checks.mjs` (must PASS again), commit.
6. `git push origin HEAD:main`, then the live loop from (a) step 6.
7. On each tablet: open the app with internet, tap "Updated. Tap to reload" (or close and reopen the app).
   The offline copy is rebuilt; after that the app opens offline again.

Proof that this works: `node tools/loops.mjs --only "kill switch"` (arms it on a local copy, checks all of the
above, goes back, then starts with no network).

## (c) GitHub Pages is down, or the repo is gone
- The installed app keeps working offline on every tablet. Do not clear the browser's data or uninstall it.
- Make a backup now on each tablet: Library → "Back up / Sync" → "Back up everything" (save the zip somewhere safe, e.g. Drive).
- The app is plain files with relative paths: any static web host can serve a copy of the repo files
  (`index.html`, `sw.js`, `manifest.webmanifest`, `css/`, `js/`, `vendor/`, `icons/`) from any folder on a DIFFERENT
  host. Not a second folder on jhoffmanteacher.github.io: every site on that address shares the browser's storage, so
  two copies there would share one library and one offline copy.
  A new address is a new app on the tablet: install it there and use Library → "Back up / Sync" → "Restore from backup".

## (d) A tablet lost its data
- Library → "Back up / Sync" → "Restore from backup", pick the latest backup zip. It is all or nothing: a damaged zip changes nothing.
- If you use Sync, Google Drive also holds weekly copies: Drive → "Setlist Stand" → "Backups". Download the newest zip to the tablet first (the Drive picker inside Restore has failed before), then Restore from backup and pick it from Downloads.
- Without a backup nothing can be recovered: the songs lived only on that tablet. That is why the Library
  nags about backups; back up after every change to the library.

## (e) After an update the page says to close the other Setlist Stand tab
The update from 2026-11-21 (Collections) changes how the library is stored (database version 2). If Setlist Stand is also open
in another tab or window that is still running the old version, the new one waits for it and says "Close the other Setlist Stand
tab". Close that tab (or the other window); the page carries on by itself and nothing is lost. If it never goes: close every
Setlist Stand tab and the Home Screen app, then open it once. A tab left open on the new version says "Reload this page" when
a still newer update is installed elsewhere: reload it before changing anything.

## (f) Sync did something wrong
Sync copies a change on one tablet to the other, so a mistake can be copied too (a song deleted by accident, a library restored from an old backup).
1. On the tablet that still has the good library: Library → "Back up / Sync" → "Back up everything". Keep that file safe.
2. Stop it spreading: on both tablets, Library → "Back up / Sync" → "Google Drive settings" → "Disconnect". Nothing is sent to Google after that, and nothing on the tablet changes.
3. To start clean: in Google Drive on a computer, delete the folder "Setlist Stand" (this loses nothing on the tablets: every tablet keeps its own copy). On BOTH tablets restore the same good backup (Library → "Back up / Sync" → "Restore from backup"), then on one tablet connect and tap Sync, then on the other.
4. Restoring an OLDER backup while Sync is still connected does not hold: the next Sync brings back whatever the other tablet changed since, because the newer change wins. Disconnect first (step 2).
5. Keep the clock of both tablets on "automatic": the newer change wins, and the tablet's clock says which is newer.

## (g) The app does not open without internet although it did before
Another website on the same address (jhoffmanteacher.github.io, for example the guitar-class site) can delete Setlist
Stand's offline copy on a tablet. Open Setlist Stand once WITH internet: it refills its offline copy by itself (no
message, nothing to tap). Then try again without internet. If a new version is waiting ("Updated. Tap to reload"),
tap it first: the new version brings its own complete offline copy.
