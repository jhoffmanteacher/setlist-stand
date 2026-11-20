"""What a MobileSheets backup (.msb) holds, read independently of tools/msb_convert.py, as JSON on stdout.
Usage: python3 -I tools/loops/msb-expected.py MobileSheets_YYYY-MM-DD.msb
Used by tools/loops/roundtrip.loop.mjs ("converter output matches the MobileSheets backup it came from").

Only the SQLite database is read (found the same way msb_convert.py main() finds it: b'SQLite format 3\\x00', its
length is the big-endian u64 just before it). Everything else is this file's own SQL. Prints ids and facts; the
caller never prints titles or texts beyond what it needs to name a difference.
  songs:     [{id, title, pages}]            songs with a PDF (a Files row of Type 1); pages honour PageOrder
  annotated: [[songId, page (1-based)]]      every page that has any annotation row
  notes:     [{song, page, text}]            text boxes (Type 0) whose text is not blank
  sets:      [{id, name, items:[{song:id} | {brk:title}]}]   in SetlistSong.Id order; a song without a PDF is a break
  crops:     [[songId, page (0-based), left, top, right, bottom]]   raw Crop rows of songs with a PDF
"""
import sys, struct, sqlite3, tempfile, os, json

def pages_of(order, count):
    """Number of pages MobileSheets shows: the pages PageOrder lists ("1-3", "1,3,4-5"), else the file's page count."""
    if not order: return count
    n = 0
    for part in order.split(','):
        part = part.strip()
        if not part: continue
        if '-' in part:
            a, b = part.split('-', 1); n += abs(int(b) - int(a)) + 1
        else: n += 1
    return n or count

def main(msb):
    d = open(msb, 'rb').read()
    s = d.find(b'SQLite format 3\x00')
    if s < 8: raise SystemExit('no SQLite database in ' + msb)
    ln = struct.unpack('>Q', d[s - 8:s])[0]
    tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False); tmp.write(d[s:s + ln]); tmp.close()
    try:
        c = sqlite3.connect(tmp.name)
        files = {sid: (order, cnt) for sid, order, cnt in c.execute('select SongId, PageOrder, SourceFilePageCount from Files where Type=1')}
        titles = dict(c.execute('select Id, Title from Songs'))
        songs = [{'id': sid, 'title': titles.get(sid, ''), 'pages': pages_of(*files[sid])} for sid in sorted(files) if sid in titles]
        annotated = sorted({(sid, pg + 1) for sid, pg in c.execute('select SongId, Page from AnnotationsBase')})
        notes = [{'song': sid, 'page': pg + 1, 'text': text} for sid, pg, text in c.execute(
            'select b.SongId, b.Page, t.Text from AnnotationsBase b join TextboxAnnotations t on t.BaseId=b.Id where b.Type=0 order by b.Id')
            if text and text.strip()]
        sets = []
        for i, name in c.execute('select Id, Name from Setlists order by Id').fetchall():
            items = []
            for (sid,) in c.execute('select SongId from SetlistSong where SetlistId=? order by Id', (i,)):
                if sid not in titles: continue                      # a row pointing at no song: MobileSheets shows nothing
                items.append({'song': sid} if sid in files else {'brk': titles[sid]})
            sets.append({'id': i, 'name': name, 'items': items})
        crops = [list(r) for r in c.execute('select SongId, Page, Left, Top, Right, Bottom from Crop order by Id') if r[0] in files]
        c.close()
    finally:
        os.unlink(tmp.name)
    json.dump({'songs': songs, 'annotated': annotated, 'notes': notes, 'sets': sets, 'crops': crops}, sys.stdout)

if __name__ == '__main__': main(sys.argv[1])
