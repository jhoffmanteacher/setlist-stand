---
paths:
  - "js/store.js"
  - "js/backup.js"
  - "js/library.js"
  - "js/errors.js"
  - "js/split.js"
  - "js/songpdf.js"
  - "js/sharepack.js"
  - "js/shareimport.js"
  - "tools/msb_convert.py"
---

## Writing code here (data, backup, restore)

1. **Restore is all or nothing:** validate everything first (zip CRC, our `library.json`, not from a newer `BACKUP_VERSION`, every song's PDF present and matching its hash), then ONE `putAll` transaction (every store in `STORE_NAMES`, collections included). Never write record by record.
1b. **Restore and Back up show a box (`busy()` in `js/util.js`) and can be stopped, but only where nothing has been written.** Restore opens the box before its first `await` and says "Opening the backup…", "Checking song N of M…", "Saving to this tablet…"; Stop (and Escape) works until the one `putAll`, says "Restore stopped. Nothing was changed.", and from `job.lock()` on is gone. Back up says "Packing song N of M…", "Making the backup file… N%"; Stop at any point downloads nothing and does not set `ss-last-backup` (set only when a file was actually saved). Every refusal still names its reason and leaves the library as it was. Proof: `--only "roundtrip progress"`.
2. **Never change a user's PDF bytes.** Stored bytes equal the file picked; the hash is of those bytes.
3. **Deletion leaves a marker** (`{id, deleted:true, updated}`) so Drive sync can tell "deleted" from "never had it"; markers are never garbage-collected. The UI hides them; backups include them. The records of a deletion are built in `js/deleteops.js` (the Delete buttons and sync's Delete here use it). **Every change to an EXISTING record is stamped with `stamp(prev)`** (`js/store.js`: `max(now, prev.updated + 1)`), so a local edit always beats the version it came from even when that came from a tablet with a wrong clock; a new place that changes a record must use it, and `--only "sync 0"` proves it. A write that must not overwrite a newer edit carries `ifUpdated` on its op (see `putAll`). Sync writes whole records and keeps fields it does not know; it never merges by title or PDF hash.
3b. **A collection's deletion** removes its id from every song and setlist that holds it, in the same `putAll`, and stamps `updated` on each (and on its own marker): sync carries a change only when `updated` moves. Records are changed by spreading the existing one, so fields this code does not know survive. Two songs may share one PDF hash (Copy): nothing new may match by hash.
4. **A new field needs a default in `upgradeSong` / `upgradeSet`** and old backups must still restore (BACKUP_VERSION only goes up; restore reads every older version). Marks stay fractions of the full page.
5. **Anything shown from a backup or file name is untrusted:** escape it (`esc`) in templates, including ids in attributes.
6. After a change: `node tools/loops.mjs --only roundtrip`, `--only hygiene-data`, `--only import`, `--only share` (a share package must hold the stored PDF bytes and no annotations), `--only split` (split import writes songs and PDFs: one `putAll` per song, hash of the stored bytes), and `node tools/names-parity.mjs <the .msb>` after touching names or the converter.
