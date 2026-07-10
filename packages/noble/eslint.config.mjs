import eslintConfig from '@penumbra-zone/configs/eslint';

export default [
  ...eslintConfig,
  {
    // the shared config sets `project: true`, which the parser resolves
    // relative to the config package inside node_modules - pin it here
    name: 'repo:tsconfig-root',
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
  },
];
