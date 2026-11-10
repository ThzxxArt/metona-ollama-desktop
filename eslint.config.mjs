import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'src/vendor/**',
      'tests/e2e/**',
      '*.config.*',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-namespace': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
      'prefer-const': 'off',
      'no-control-regex': 'off',
      'no-case-declarations': 'off',
    },
  },
);
