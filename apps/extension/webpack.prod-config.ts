import path from 'node:path';
import config from './webpack.config.js';

const __dirname = new URL('.', import.meta.url).pathname;

const ZIGNER_ID = 'lkpmkhpnhknhmibgnmmhdhgdilepfghe';

/**
 * This config defines the zigner-web Chrome ID and the output directory
 */
export default ({ WEBPACK_WATCH = false }: { ['WEBPACK_WATCH']?: boolean }) => {
  const configs = config({ ZIGNER_ID, WEBPACK_WATCH });
  const distPath = path.join(__dirname, 'dist');
  return configs.map(cfg => ({
    ...cfg,
    output: { ...cfg.output, path: distPath },
  }));
};
