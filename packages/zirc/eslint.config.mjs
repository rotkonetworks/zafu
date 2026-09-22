import eslintConfig from '@penumbra-zone/configs/eslint';

export default [
  ...eslintConfig,
  {
    // the shared config sets `project: true`, which the parser resolves
    // relative to the config package inside node_modules - pin it here
    name: 'repo:tsconfig-root',
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
  },
  {
    // @zafu/zirc follows zid's lint posture: type-aware lint with the
    // incremental-adoption escape hatch, so a genuinely unsafe pattern is an error
    // while stylistic friction (async without await in a test double, a non-null
    // assertion in a fixture) stays visible without gating a publish.
    name: 'repo:zirc-incremental-type-adoption',
    rules: {
      // crypto + byte-packing code (nonce counters, memo framing, tag masks) is
      // inherently bitwise - the rule does not apply to this package.
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
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
  },
];
