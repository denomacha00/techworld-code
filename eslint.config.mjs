import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [{
  files: ['**/*.ts'],
  languageOptions: { parser, parserOptions: { ecmaVersion: 2022, sourceType: 'module' } },
  plugins: { '@typescript-eslint': tseslint },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/consistent-type-imports': 'error'
  }
}];
