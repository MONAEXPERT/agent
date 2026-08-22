// ESLint flat config — a deliberately small, strict rule set for plain ESM.
//
// Design notes (see CODE-AUDIT.md §4.1):
//   - Not a large preset: this codebase has its own style; the point is to
//     catch real defects (unused vars/exports, shadowing, swallowed errors,
//     accidental fallthrough), not to restyle it.
//   - Empty catch blocks must carry a /* best-effort: reason */ comment
//     (local rule no-silent-catch) so a swallowed error is always a
//     documented decision, never an accident.
//   - `npm run lint` runs this after the fast syntax check.
import js from '@eslint/js';
import globals from 'globals';

const noSilentCatch = {
  rules: {
    'no-silent-catch': {
      meta: {
        type: 'suggestion',
        docs: {
          description: 'empty catch blocks must carry a best-effort comment',
        },
        messages: {
          undocumented:
            'Empty catch block must carry a /* best-effort: <reason> */ comment',
        },
        schema: [],
      },
      create(context) {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        return {
          CatchClause(node) {
            if (!node.body || node.body.type !== 'BlockStatement') return;
            const statements = node.body.body.filter(
              (s) => s.type !== 'EmptyStatement'
            );
            if (statements.length > 0) return;
            const comments = sourceCode.getCommentsInside(node.body);
            if (comments.length === 0) {
              context.report({ node, messageId: 'undocumented' });
            }
          },
        };
      },
    },
  },
};

export default [
  { ignores: ['node_modules/**', 'docs/**', 'examples/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
        URL: 'readonly',
        fetch: 'readonly',
        structuredClone: 'readonly',
      },
    },
    plugins: { local: noSilentCatch },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-unreachable': 'error',
      'no-shadow': 'error',
      'no-fallthrough': 'error',
      'no-constant-condition': 'error',
      'no-dupe-keys': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }], // no-silent-catch enforces the comment
      'local/no-silent-catch': 'error',
      'require-atomic-updates': 'warn',
      'no-await-in-loop': 'warn',
      'eqeqeq': 'warn',
    },
  },
];
