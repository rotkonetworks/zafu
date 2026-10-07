/**
 * The console of a shipped build is readable by anyone at the machine and by
 * every crash report pasted into an issue. A log line naming a note's value,
 * its tree position, a txid or a ring index ties the wallet to its money, so
 * none of them may be printed outside a dev build.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(__dirname, '..');

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory()
      ? files(p)
      : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)
        ? [p]
        : [];
  });

/** what a log line must never carry (a count of them is fine): amounts, positions, txids, the ring index */
const SECRET =
  /value=|\bpos=|\$\{[^}]*(txid|value|position|amount|zat\b|address|myIndex|nullifier)[^}]*\}|, *(txid|amount|address|myIndex|position)\b/i;

/** each console call's argument text, with its line */
const logCalls = (text: string) =>
  [...text.matchAll(/console\.(?:log|debug|info|warn|error)\(([\s\S]*?)\);/g)].map(m => ({
    line: text.slice(0, m.index).split('\n').length,
    args: m[1]!,
  }));

describe('quiet logs', () => {
  it('no console log prints a value, position, txid, address or ring index', () => {
    const loud = files(src).flatMap(f =>
      logCalls(readFileSync(f, 'utf8'))
        .filter(c => SECRET.test(c.args.replace(/[\w.]+\.length\b/g, 'n')))
        .map(c => `${f.slice(src.length + 1)}:${c.line}`),
    );
    expect(loud).toEqual([]);
  });
});
