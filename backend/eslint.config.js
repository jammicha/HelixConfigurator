const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

// Flat config (ESLint 10) for the plain-JS backend. Source is CommonJS
// (require/module.exports); the test suite under __tests__/ is ESM (.mjs).
// no-unused-vars is WARN so the gate is green from day one and can be wired
// into CI immediately; ratchet to 'error' + --max-warnings=0 once clean.
module.exports = [
  { ignores: ['node_modules', 'data', 'coverage'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Test suite is ESM: __tests__/*.test.mjs plus the root-level *.test.js
    // files (vitest transforms them as modules regardless of the .js extension).
    files: ['**/*.mjs', '**/*.test.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Baseline calibration for the existing tree (ratchet to stricter later):
    //  - allowEmptyCatch: the index-creation catches in otelStore.js are
    //    intentional idempotent-DDL swallows; keep no-empty active elsewhere.
    //  - the two below flag genuine (if minor) smells — a fragile async Promise
    //    executor in discovery.js and a dead initializer in diagnostics.js —
    //    surfaced as warnings so they're visible without blocking the gate or
    //    forcing behavioral edits to untested code in this tooling-only change.
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-async-promise-executor': 'warn',
      'no-useless-assignment': 'warn',
    },
  },
  prettier,
];
