'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'data/**'] },
  js.configs.recommended,
  {
    // the server and the tests: Node, CommonJS
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2023, globals: globals.node },
    rules: {
      // an ignored error must say why (a comment inside the block) so nothing disappears without a trace
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
