/* eslint.config.mjs: the name checker (ported from guitar-class). Report-only.

   Run it through tools/lint.mjs: it fetches ESLint with npx at the versions pinned below, so nothing is installed
   in the repo and nothing here ships (it is not precached). A bare `npx eslint@<ESLINT_VERSION>` also reads this
   file, but then `globals` must be installed next to it.

   The app is ES modules, so each file has its own scope and no cross-file name list is needed (unlike guitar-class):
     js/ (every .js)    modules, browser globals + the three vendored libraries (classic scripts in index.html that
                        put pdfjsLib, PDFLib, JSZip on window)
     sw.js              classic script, service-worker globals
     tools/**, .claude/hooks/, this file
                        modules, node globals. Loop and smoke files also hand functions to page.evaluate(), which
                        run in the browser, so browser globals are allowed there too (ESLint cannot tell which
                        function runs where).

   Rules: correctness only, no formatting. no-unused-vars is a warning (arguments and catch bindings are not
   checked: handler and callback signatures keep them on purpose). eqeqeq is off: the code uses == null on purpose. */

/* The exact versions npx fetches (each published at least two weeks before it was pinned; eslint 10.14.0 on
   2026-10-30, globals 17.14.0 on 2026-11-01, pinned 2026-11-19). Change them here only. */
export const ESLINT_VERSION = '10.14.0';
export const GLOBALS_VERSION = '17.14.0';

export const RULES = {
  'no-undef': ['error', { typeof: false }],
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'no-self-assign': 'error',
  'no-import-assign': 'error',
  'no-dupe-else-if': 'error',
  'no-unsafe-finally': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  eqeqeq: 'off',
};

/* Names from outside the app's own modules: the vendored libraries (CLAUDE.md "Stack rules"), loaded by
   index.html as classic scripts. A name goes here only when it really exists at run time; never to silence a finding. */
export const VENDOR_GLOBALS = { pdfjsLib: 'readonly', PDFLib: 'readonly', JSZip: 'readonly' };

/* Which files, and how. `globals` is the `globals` npm package (tools/lint.mjs passes it in). */
export function configs(globals) {
  const ro = (o) => Object.fromEntries(Object.keys(o).map((k) => [k, 'readonly']));
  return [
    { ignores: ['vendor/**', 'node_modules/**', 'Claude outputs/**', 'tests/**'] },
    {
      files: ['js/**/*.js'],
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...ro(globals.browser), ...VENDOR_GLOBALS } },
      rules: RULES,
    },
    {
      files: ['sw.js'],
      languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: ro(globals.serviceworker) },
      rules: RULES,
    },
    {
      files: ['tools/**/*.mjs', '.claude/hooks/*.mjs', 'eslint.config.mjs'],
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...ro(globals.browser), ...ro(globals.node), ...VENDOR_GLOBALS } },
      rules: RULES,
    },
  ];
}

/* A bare `npx eslint` (with globals installed beside it) gets the same configs. */
let g = null;
try { g = (await import('globals')).default; } catch { /* not installed: tools/lint.mjs passes it in */ }
export default g ? configs(g) : [{ ignores: ['**/*'] }];
