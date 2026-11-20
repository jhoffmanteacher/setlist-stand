---
paths:
  - "js/store.js"
  - "js/backup.js"
  - "js/library.js"
  - "js/errors.js"
  - "tools/msb_convert.py"
---

## Writing code here (data, backup, restore)

1. **Restore is all or nothing:** validate everything first (zip CRC, our `library.json`, not from a newer `BACKUP_VERSION`, every song's PDF present and matching its hash), then ONE `putAll` transaction. Never write record by record.
2. **Never change a user's PDF bytes.** Stored bytes equal the file picked; the hash is of those bytes.
3. **Deletion leaves a marker** (`{id, deleted:true, updated}`) so a later Drive sync can tell "deleted" from "never had it"; markers are never garbage-collected. The UI hides them; backups include them.
4. **A new field needs a default in `upgradeSong` / `upgradeSet`** and old backups must still restore (BACKUP_VERSION only goes up; restore reads every older version). Marks stay fractions of the full page.
5. **Anything shown from a backup or file name is untrusted:** escape it (`esc`) in templates, including ids in attributes.
6. After a change: `node tools/loops.mjs --only roundtrip`, `--only hygiene-data`, `--only import`, and `node tools/names-parity.mjs <the .msb>` after touching names or the converter.
