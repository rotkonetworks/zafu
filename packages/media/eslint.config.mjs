import eslintConfig from '@penumbra-zone/configs/eslint';

export default [
  {
    // Type-aware lint only parses files in this package's tsconfig
    // (include: ["src"]). Build/test config files live at the package root and
    // are not in that project, so exclude them rather than 500 on a parse error.
    name: 'repo:media-ignores',
    ignores: ['dist/**', '**/*.config.ts', '**/*.config.mjs'],
  },
  ...eslintConfig,
  {
    // the shared config sets `project: true`, which the parser resolves
    // relative to the config package inside node_modules - pin it here.
    name: 'repo:tsconfig-root',
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
  },
  {
    // @zafu/media is onboarding type-aware lint for the first time (it never had
    // an eslint config). The WebRTC / perfect-negotiation / blur code predates
    // the strict ruleset and leans on non-null assertions and `||` defaults at
    // untyped browser-API boundaries. Surface those as WARNINGS - visible, not
    // gating - so the package lints green while the style is cleaned up
    // incrementally, mirroring how @zafu/zid was onboarded.
    name: 'repo:media-incremental-type-adoption',
    rules: {
      'no-bitwise': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      '@typescript-eslint/prefer-optional-chain': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/no-empty-function': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/require-await': 'warn',
    },
  },
];
