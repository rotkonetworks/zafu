#!/usr/bin/env node
/**
 * Dependency-free self-test for recover.mjs. Encrypts a known seed with the
 * exact zafu scheme (PBKDF2-SHA-512 210k -> AES-GCM-256, SHA-256 keyprint hash),
 * writes a chrome.storage.local-shaped dump, then drives the real recover.mjs
 * CLI and asserts the seed comes back and a wrong password is rejected.
 *
 *   node selftest.mjs
 */
import { webcrypto as crypto } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const b64e = u8 => Buffer.from(u8).toString('base64');

const SEED = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASSWORD = 'sunflower-seedvault-2026';

async function encryptLikeZafu(password, message) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-512' },
    km,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt'],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipherText = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      new TextEncoder().encode(message),
    ),
  );
  return {
    passwordKeyPrint: { hash: b64e(hash), salt: b64e(salt) },
    box: { nonce: b64e(nonce), cipherText: b64e(cipherText) },
  };
}

const { passwordKeyPrint, box } = await encryptLikeZafu(PASSWORD, SEED);
const dump = {
  passwordKeyPrint,
  vaults: [
    {
      id: 'v1',
      type: 'mnemonic',
      name: 'Main',
      encryptedData: JSON.stringify(box),
      salt: '',
      insensitive: {},
    },
  ],
  privacySettings: { hideBalances: true },
};
const dumpPath = join(here, '.selftest-dump.json');
writeFileSync(dumpPath, JSON.stringify(dump));
const recover = join(here, 'recover.mjs');

let failures = 0;
try {
  const out = execFileSync('node', [recover, dumpPath], {
    env: { ...process.env, WALLET_RECOVERY_PASSWORD: PASSWORD },
    encoding: 'utf8',
  });
  if (out.includes(SEED)) console.log('PASS: correct password recovers the seed');
  else {
    console.error('FAIL: seed not in output');
    failures++;
  }

  try {
    execFileSync('node', [recover, dumpPath], {
      env: { ...process.env, WALLET_RECOVERY_PASSWORD: 'wrong' },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    console.error('FAIL: wrong password did not error');
    failures++;
  } catch {
    console.log('PASS: wrong password is rejected (non-zero exit)');
  }
} finally {
  rmSync(dumpPath, { force: true });
}
process.exit(failures ? 1 : 0);
