import eslintConfig from '@penumbra-zone/configs/eslint';

export default [
  ...eslintConfig,
  {
    name: 'repo:tsconfig-root',
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
  },
];
