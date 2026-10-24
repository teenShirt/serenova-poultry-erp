import tseslint from 'typescript-eslint'

/**
 * Only the checks that matter for async database code: every promise must be awaited and
 * never used as a condition. A forgotten `await` would otherwise skip a check or a write.
 */
export default tseslint.config({
  files: ['**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { project: ['./tsconfig.node.json'], tsconfigRootDir: import.meta.dirname }
  },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/require-await': 'off',
    '@typescript-eslint/return-await': ['error', 'in-try-catch']
  }
})
