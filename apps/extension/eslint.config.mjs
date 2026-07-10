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
    name: 'custom-local-ignores',
    rules: {
      // Existing disabled rules
      'no-nested-ternary': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Chrome-related deprecation warnings
      '@typescript-eslint/no-deprecated': 'off',

      // React Hooks warnings
      'react-hooks/exhaustive-deps': 'off',

      // Global object usage
      'no-restricted-globals': 'off',

      // Fragment usage
      'react/jsx-no-useless-fragment': 'off',

      // Parameter reassignment
      'no-param-reassign': 'off',

      // Import duplicates
      'import/no-duplicates': 'off',

      // Unused vars and expressions
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',

      // Await and promise-related rules
      '@typescript-eslint/await-thenable': 'off',
      'no-promise-executor-return': 'off',

      // Type parameter rules
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      '@typescript-eslint/no-duplicate-type-constituents': 'off',

      // Switch exhaustiveness
      '@typescript-eslint/switch-exhaustiveness-check': 'off',

      // Console statements
      'no-console': 'off',

      // Comment formatting
      'spaced-comment': 'off',
      '@eslint-community/eslint-comments/require-description': 'off',

      // Catch callback type
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',

      // Global definition (for tests)
      'no-undef': 'off',
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },

  {
    // The eslint stage of lint:strict was silently broken for months (the
    // shared config's `project: true` resolved against node_modules), so a
    // large body of code was written unchecked. The rules below are off
    // because bringing the backlog into compliance is a project of its own -
    // re-enable them one at a time as the debt is paid down. tsc --noEmit
    // still gates types; auto-fixable rules were applied before this block
    // was added.
    name: 'lint-debt-2026-07',
    rules: {
      'no-bitwise': 'off', // deliberate in QR/crypto encoders
      'react/no-unescaped-entities': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      'no-empty': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-spread': 'off',
      '@typescript-eslint/no-non-null-asserted-nullish-coalescing': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/prefer-for-of': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/return-await': 'off',
      'prefer-const': 'off',
      // its autofix strips generics that inference cannot recover (sendWindow<T>)
      '@typescript-eslint/no-unnecessary-type-arguments': 'off',
    },
  },

  {
    // test files are outside the tsconfig project, so type-aware parsing
    // fails on them; vitest runs them - eslint skips them
    name: 'ignore-out-of-project-tests',
    ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.node.test.mjs'],
  },
];
