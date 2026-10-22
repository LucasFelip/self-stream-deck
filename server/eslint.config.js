'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'data/**'] },
  js.configs.recommended,
  {
    // the server and the tests: Node, CommonJS
    files: ['src/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2023, globals: globals.node },
    rules: {
      // an ignored error must say why (a comment inside the block) so nothing disappears without a trace
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
  {
    // the interface: plain scripts sharing the Deck namespace, loaded by index.html in order
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', ecmaVersion: 2023, globals: { ...globals.browser, Deck: 'writable', DeckGeometry: 'readonly', Android: 'readonly', module: 'readonly' } }, // module: geometry.js also loads in Node (UMD)
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
