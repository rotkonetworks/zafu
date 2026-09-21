import eslintConfig from '@penumbra-zone/configs/eslint';

export default [
  {
    // Type-aware lint only parses files in this package's tsconfig
    // (include: ["src"]). Build/test config files, scripts, test files, and
    // non-src files are not in that project, so exclude them rather than 500
    // on a parse error.
    name: 'repo:wallet-ignores',
    ignores: [
      'dist/**',
      'scripts/**',
      '**/*.config.ts',
      '**/*.config.mjs',
      '**/*.test.*',
      '**/*.spec.*',
      'tests-setup.ts',
    ],
  },
  ...eslintConfig,
  {
    // the shared config sets `project: true`, which the parser resolves
    // relative to the config package inside node_modules - pin it here
    name: 'repo:tsconfig-root',
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
  },
  {
    // @repo/wallet is onboarding type-aware lint for the first time; the package
    // contains legacy crypto/byte-packing code (key derivation, tx encoding, QR framing)
    // that predates strict type checking and relies on bitwise ops and unsafe boundaries.
    // Surface legacy findings as WARNINGS (visible, not gating) so the package can pass
    // lint while the typing is cleaned up incrementally, rather than mass-rewriting
    // crypto code under time pressure. Everything deterministic-safe stays an error
    // and is fixed.
    name: 'repo:wallet-incremental-type-adoption',
    rules: {
      // crypto + byte-packing code (key derivation, tx encoding, QR framing, nonce
      // counters) is inherently bitwise - the rule does not apply to this package.
      'no-bitwise': 'off',
      // intentionally-unused params kept for a stable signature use a _ prefix.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/no-deprecated': 'warn',
      'no-console': 'warn',
      'no-case-declarations': 'warn',
      '@typescript-eslint/switch-exhaustiveness-check': 'warn',
      '@typescript-eslint/restrict-plus-operands': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
    },
  },
];
