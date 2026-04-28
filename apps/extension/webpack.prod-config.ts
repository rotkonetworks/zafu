import path from 'node:path';
import config from './webpack.config.js';

const __dirname = new URL('.', import.meta.url).pathname;

/**
 * Prod build only changes the output directory. The extension id is resolved
 * at runtime via chrome.runtime.id so no per-build constant is needed.
 */
export default ({ WEBPACK_WATCH = false }: { ['WEBPACK_WATCH']?: boolean }) => {
  const configs = config({ WEBPACK_WATCH });
  const distPath = path.join(__dirname, 'dist');
  return configs.map(cfg => ({
    ...cfg,
    output: { ...cfg.output, path: distPath },
  }));
};
