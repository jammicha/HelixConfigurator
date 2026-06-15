import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Flat config (ESLint 10). Lints the application source under src/.
//
// Calibrated for a green baseline so the gate can go into CI now, then ratchet:
//  - no-explicit-any / no-unused-vars are WARN — the codebase carries known
//    `any` debt that the strict-mode pass pays down incrementally.
//  - Only the two classic react-hooks rules are enabled. react-hooks v7's full
//    recommended set adds aggressive React-Compiler rules (purity, immutability,
//    set-state-in-render) that would flag the large components wholesale;
//    enabling those is a deliberate refactor step, not a tooling rollout.
// Ratchet the warnings to 'error' (and add --max-warnings=0 in CI) as counts drop.
export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // The empty blocks in the tree are all deliberate silent-failure catches
      // (clipboard/localStorage/logout best-effort); keep no-empty active for
      // other empty blocks.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Test files run under vitest with imported helpers; allow its globals so
  // they don't trip no-undef when a test relies on the global form.
  {
    files: ['**/*.test.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, vi: 'readonly', vitest: 'readonly' },
    },
  },
  // Keep ESLint out of Prettier's lane (must stay last).
  prettier,
);
