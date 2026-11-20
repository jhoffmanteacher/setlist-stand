// Parity check: js/names.js splitName() vs split_name() in tools/msb_convert.py.
// Usage: node tools/names-parity.mjs <path to .msb>
// Prints "N of M match" (every Songs.Title in the backup) and "N of M extra cases match"
// (hand-made adversarial inputs below), listing each difference. Exit 1 if any differ.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { splitName } from '../js/names.js';

const EXTRA = [
  '', '   ', '  Wonderwall  ', 'Wonderwall.pdf', 'Wonderwall.PDF', 'Wonderwall (1)', 'Wonderwall (1).pdf',
  'Wonderwall - Chords', 'Wonderwall - Chords 2', 'Wonderwall-Chords', 'Wonderwall - Pro',
  'Wonderwall - Lyrics - Chords', 'Wonderwall - Lyrics - Chords 3', 'Wonderwall chords', 'Wonderwall CHORDS',
  'Oasis - Wonderwall - Chords', 'The Doors - Soul Kitchen - Chords', 'High And Dry - Chords',
  'What Goes On - Pro', 'Stand By Me - D', 'X - D', 'Song in A', 'Song in A and B', 'Song in H',
  'Hey Jude OLD', 'Hey Jude updated', 'Hey Jude Lyrics', 'Hey Jude 2', 'Hey Jude #2',
  'XO - Beyonce', 'ABC OF THE BLUES', 'a day in the life of a fool', 'Dont Stop Believin',
  "don't stop me now", "Rock 'n' Roll Ain't Noise Pollution", 'A - B - C - D', 'One - Two - Three',
  'Cat Stevens Yusuf Islam - Wild World', 'Father And Son - Cat Stevens Yusuf Islam',
  'Song  with   extra    spaces', 'Wonderwall chords 2', 'ab - cd', 'abc - de', 'the', 'OLD',
  'Im Yours - Jason Mraz', 'Hotel California 2 chords', 'Song Name　here', 'Ünïcödé ÉCOLE song',
  'Song\u001c', 'Song CHORDſ', 'Song (1)\n.pdf', 'Song ١٢', 'Song - Chords ٣', 'ǅemal song', 'İSTANBUL',
];

const here = path.dirname(fileURLToPath(import.meta.url));
const msb = process.argv[2];
if (!msb) { console.error('usage: node tools/names-parity.mjs <path to .msb>'); process.exit(2); }

const PY = String.raw`
import sys, json, struct, sqlite3, tempfile, os
args = json.loads(sys.stdin.read())
sys.path.insert(0, args['tools'])
from msb_convert import split_name
d = open(args['msb'], 'rb').read()
s = d.find(b'SQLite format 3\x00'); ln = struct.unpack('>Q', d[s-8:s])[0]
tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False); tmp.write(d[s:s+ln]); tmp.close()
c = sqlite3.connect(tmp.name)
titles = [r[0] for r in c.execute('select Title from Songs order by Id').fetchall()]
c.close(); os.unlink(tmp.name)
res = lambda xs: [[x, list(split_name(x))] for x in xs]
print(json.dumps({'real': res(titles), 'extra': res(args['extra'])}))
`;

const py = spawnSync('python3', ['-c', PY], {
  input: JSON.stringify({ tools: here, msb: path.resolve(msb), extra: EXTRA }),
  encoding: 'utf8', maxBuffer: 64 << 20,
});
if (py.status !== 0) { console.error(py.stderr || py.error); process.exit(2); }
const out = JSON.parse(py.stdout);

let failed = false;
function compare(rows, label) {
  const diffs = [];
  for (const [raw, [song, artist, version]] of rows) {
    const js = splitName(raw);
    if (js.song !== song || js.artist !== artist || js.version !== version) diffs.push({ raw, py: { song, artist, version }, js });
  }
  console.log(`${rows.length - diffs.length} of ${rows.length} ${label}`);
  for (const d of diffs) console.log(`  ${JSON.stringify(d.raw)}\n    python: ${JSON.stringify(d.py)}\n    js:     ${JSON.stringify(d.js)}`);
  if (diffs.length) failed = true;
}
compare(out.real, 'match');
compare(out.extra, 'extra cases match');
process.exit(failed ? 1 : 0);
