import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src/api/schema.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // an ignored error must say why (a comment inside the block), as in the rest of the repository
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
  { files: ['*.config.{js,ts}'], languageOptions: { globals: { ...globals.node } } },
  // the browser tests share the CommonJS harness of the old interface's tests
  { files: ['e2e/**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } }, rules: { '@typescript-eslint/no-require-imports': 'off' } },
);
