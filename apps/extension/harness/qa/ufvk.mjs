// the unified viewing key of a seed file's account 0. usage: node ufvk.mjs <seed-file> [main|test]
// the seed never leaves this process; only the viewing key is printed
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

globalThis.self = { addEventListener() {}, removeEventListener() {} };
const pkg = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/zcash-wasm',
);
const W = await import(path.join(pkg, 'zafu_wasm.js'));
W.initSync({ module: fs.readFileSync(path.join(pkg, 'zafu_wasm_bg.wasm')) });
const [file, net = 'main'] = process.argv.slice(2);
console.log(new W.SpendKeys(fs.readFileSync(file, 'utf8').trim(), 0, net === 'main').ufvk());
