#!/usr/bin/env node
/**
 * zafu wallet disk-recovery tool - STANDALONE. No dependencies, no zafu code.
 *
 * Recovers seed phrases from a chrome.storage.local dump + the wallet password.
 * The crypto matches @repo/encryption exactly:
 *   key  = PBKDF2-SHA-512(password, passwordKeyPrint.salt, 210000) -> AES-GCM-256
 *   seed = AES-GCM-decrypt(box.cipherText, iv = box.nonce, key)
 * passwordKeyPrint.hash = SHA-256(raw key) is used only to verify the password.
 *
 * See RECOVERY.md for how to extract the dump from the Chrome profile.
 *
 * Usage:
 *   node recover.mjs <dump.json>
 *   WALLET_RECOVERY_PASSWORD=... node recover.mjs <dump.json>   # non-interactive
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { webcrypto as crypto } from 'node:crypto';

const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
const bytesEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

async function deriveKey(password, saltB64) {
  const km = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64(saltB64), iterations: 210000, hash: 'SHA-512' },
    km,
    { name: 'AES-GCM', length: 256 },
    true,
    ['decrypt'],
  );
}

async function passwordMatches(key, hashB64) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return bytesEq(h, b64(hashB64));
}

async function decryptBox(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(box.nonce) }, key, b64(box.cipherText));
  return new TextDecoder().decode(pt);
}

const isBox = (v) => v && typeof v === 'object' && typeof v.nonce === 'string' && typeof v.cipherText === 'string';
const isKeyPrint = (v) =>
  v && typeof v === 'object' && typeof v.hash === 'string' && typeof v.salt === 'string' && !('nonce' in v);

// Recursively find the keyprint (salt/hash) and every encrypted box, so the
// tool survives storage-schema/version changes without knowing exact paths.
function walk(node, path, keyprints, boxes) {
  if (node == null) return;
  if (typeof node === 'string') {
    // encryptedData is stored as a stringified Box.
    if (node.startsWith('{') && node.includes('cipherText')) {
      try {
        const p = JSON.parse(node);
        if (isBox(p)) boxes.push({ path, box: p });
      } catch {
        /* not JSON */
      }
    }
    return;
  }
  if (isKeyPrint(node)) keyprints.push({ path, ...node });
  if (isBox(node)) {
    boxes.push({ path, box: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, keyprints, boxes));
  } else if (typeof node === 'object') {
    for (const k of Object.keys(node)) walk(node[k], path ? `${path}.${k}` : k, keyprints, boxes);
  }
}

function askPassword() {
  if (process.env.WALLET_RECOVERY_PASSWORD != null) {
    return Promise.resolve(process.env.WALLET_RECOVERY_PASSWORD);
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Mute echo so the password is not shown / logged.
    rl._writeToOutput = () => {};
    process.stdout.write('wallet password: ');
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node recover.mjs <chrome.storage.local-dump.json>');
    console.error('see RECOVERY.md for how to extract the dump.');
    process.exit(1);
  }
  const dump = JSON.parse(readFileSync(file, 'utf8'));
  const keyprints = [];
  const boxes = [];
  walk(dump, '', keyprints, boxes);

  if (keyprints.length === 0) {
    console.error('error: no passwordKeyPrint (salt/hash) found - is this a zafu chrome.storage.local dump?');
    process.exit(1);
  }
  if (boxes.length === 0) {
    console.error('error: no encrypted seed boxes found in the dump.');
    process.exit(1);
  }
  // Prefer the top-level master passwordKeyPrint; a dump may also contain a
  // self-contained multisig-backup keyprint (opened by its own passphrase).
  const kp = keyprints.find((k) => k.path === 'passwordKeyPrint') ?? keyprints[0];
  console.error(`keyprint: "${kp.path}"   encrypted boxes: ${boxes.length}`);

  const password = await askPassword();
  const key = await deriveKey(password, kp.salt);
  if (!(await passwordMatches(key, kp.hash))) {
    console.error('WRONG PASSWORD (keyprint hash mismatch). nothing decrypted.');
    process.exit(2);
  }
  console.error('password verified. recovered secrets:\n');

  let ok = 0;
  for (const { path, box } of boxes) {
    try {
      const plaintext = await decryptBox(key, box);
      console.log(`# ${path}`);
      console.log(plaintext);
      console.log('');
      ok++;
    } catch {
      // A box under a different key (e.g. a self-contained multisig backup with
      // its own keyprint) will not open with the master key - that's expected.
      console.error(`# ${path}: skipped (different key)`);
    }
  }
  console.error(`\ndone: ${ok}/${boxes.length} boxes recovered with the master key.`);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
