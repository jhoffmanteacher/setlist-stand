# Third-party software in Setlist Stand

Everything below is copied into `vendor/` so the app works with no network. Nothing is loaded from another host at runtime.
The full license texts are in `docs/licenses/`; each library's own license notice is also kept in its minified file.

| What | Version | License | Where | Full text |
|---|---|---|---|---|
| pdf.js (Mozilla) | 3.11.174 | Apache-2.0 | `vendor/pdf.min.js`, `vendor/pdf.worker.min.js` | `docs/licenses/pdfjs-LICENSE.txt` |
| pdf-lib (Andrew Dillon) | 1.17.1 | MIT | `vendor/pdf-lib.min.js` | `docs/licenses/pdf-lib-LICENSE.txt` |
| JSZip (Stuart Knightley and others), with pako (MIT) | 3.10.1 | MIT or GPL-3.0 (used under MIT) | `vendor/jszip.min.js` | `docs/licenses/jszip-LICENSE.txt` |
| Barlow (The Barlow Project Authors) | Google Fonts v13 | SIL Open Font License 1.1 | `vendor/fonts/barlow-*.ttf` | `docs/licenses/barlow-OFL.txt` |
| Barlow Condensed (The Barlow Project Authors) | Google Fonts v13 | SIL Open Font License 1.1 | `vendor/fonts/barlowcondensed-*.ttf` | `docs/licenses/barlowcondensed-OFL.txt` |

Rules: add a row here (and the license text) in the same commit that adds any new vendored file. The fonts are used unmodified and
are not sold on their own. Adding any library beyond these needs Jonathan's OK (see `CLAUDE.md`).
