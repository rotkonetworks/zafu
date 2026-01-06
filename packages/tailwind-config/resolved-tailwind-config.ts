// eslint-disable-next-line @typescript-eslint/no-require-imports
const resolveConfig = require('tailwindcss/resolveConfig');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tailwindConfig = require('@repo/tailwind-config');

export const RESOLVED_TAILWIND_CONFIG = resolveConfig(tailwindConfig);
