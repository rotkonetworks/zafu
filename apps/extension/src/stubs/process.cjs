// Minimal browser `process` shim.
//
// DefinePlugin replaces the specific `process.env.X` tokens the app reads at
// build time (see webpack.config.ts). This shim exists only so that a bare
// `process` / `process.browser` / `process.env` reference from a dependency in
// the browser bundle does not throw "process is not defined" at runtime. It is
// intentionally inert - no real env, MV3-CSP-safe (no eval, no node APIs).
const noop = () => {};
module.exports = {
  env: {},
  browser: true,
  version: '',
  versions: {},
  platform: 'browser',
  argv: [],
  nextTick: (cb, ...args) => Promise.resolve().then(() => cb(...args)),
  on: noop,
  once: noop,
  off: noop,
  emit: noop,
  cwd: () => '/',
};
