import eslint from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'pnpm-lock.yaml'],
  },
  // Base configuration for JS and TS files
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js'],
    plugins: {
      import: importPlugin,
    },
    rules: {
      // Style rules that follow Standard JS
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always'],
      'no-trailing-spaces': 'error',
      'eol-last': ['error', 'always'],
      indent: ['error', 2, { SwitchCase: 1 }],

      // Strict TypeScript code quality rules
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],

      // Enforce strict import ordering
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },
);
