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

**pdf.js 3.11.174 is older than CVE-2024-4367 (fixed in 4.2.67):** a hostile PDF could run code when pdf.js is allowed to compile code
(its `isEvalSupported` option). Kept on purpose (Jonathan, 2026-11-24); an upgrade would be its own work order. Two things block it here,
and `node tools/checks.mjs` ("pdf.js eval guard") pins the second one: (1) the page's Content-Security-Policy has no `unsafe-eval` (pinned
as the whole policy in `tools/checks.mjs`); (2) `js/util.js` replaces `window.pdfjsLib` with a stand-in whose `getDocument` passes
`isEvalSupported:false` after the caller's options, and every file that opens a PDF imports `./util.js`. The `hygiene: CSP holds` loop
records what every `getDocument` call receives (a spy under the stand-in) and fails on anything but `false`.

Rules: add a row here (and the license text) in the same commit that adds any new vendored file. The fonts are used unmodified and
are not sold on their own. Adding any library beyond these needs Jonathan's OK (see `CLAUDE.md`).
