module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['plugin:@typescript-eslint/recommended'],
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  env: { node: true },
  ignorePatterns: ['dist/'],
  overrides: [
    {
      files: ['test/*.cjs'],
      rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
  ],
};
