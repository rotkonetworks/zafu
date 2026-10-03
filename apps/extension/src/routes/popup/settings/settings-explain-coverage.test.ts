import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Guards the rule in AGENTS.md / the redesign's settings philosophy: every
 * user-settable row (a toggle, or a value row that opens a sheet in place -
 * not a row that merely navigates to another route) must be able to open an
 * explanation. A row that only navigates (it carries a `preload` route, or
 * is `type='screen'`) is exempt - the destination screen explains itself.
 *
 * This is a static source scan, not a render test: it looks at each `<Row`
 * (or a handful of known wrapper components that render one: OptionsRow,
 * KeplrCompatToggle, ThemeRow, FontRow, ApprovalsRow, AutoLockRow,
 * SigningRow, NodeSheet, DestinationRow) and checks the JSX call for an
 * `onExplain` prop or a `{...explainProps(...)}` spread. A row can opt out
 * explicitly with a `{/* no-explain: <reason> *\/}` comment directly above it -
 * grep-able, so an opt-out is never silent.
 */

const settingsDir = dirname(fileURLToPath(import.meta.url));

const WRAPPER_TAGS = [
  'Row',
  'OptionsRow',
  'KeplrCompatToggle',
  'ThemeRow',
  'FontRow',
  'ApprovalsRow',
  'AutoLockRow',
  'SigningRow',
  'NodeSheet',
  'ZcashNodeSheet',
  'DestinationRow',
  'ZcashMeRow',
  'ContactDiscoverySection',
  'ChainRow',
];

interface Finding {
  file: string;
  snippet: string;
}

function hasExemptionComment(src: string, blockStart: number): boolean {
  const before = src.slice(Math.max(0, blockStart - 120), blockStart);
  return /no-explain:/.test(before);
}

/**
 * Extract one JSX element's full source, starting at the `<Tag` index,
 * through its matching close - tracking nested tags by depth so a nested
 * self-closing element (e.g. `custom={<Segmented ... />}`) doesn't look
 * like our tag's own end. `=>` (arrows) are not `<` or `/>`, so they don't
 * perturb the count.
 */
function extractElement(src: string, start: number): string {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    if (src.startsWith('</', i)) {
      depth--;
      const end = src.indexOf('>', i);
      i = end === -1 ? src.length : end + 1;
      if (depth <= 0) return src.slice(start, i);
      continue;
    }
    if (src[i] === '<') {
      depth++;
      i++;
      continue;
    }
    if (src.startsWith('/>', i)) {
      depth--;
      i += 2;
      if (depth <= 0) return src.slice(start, i);
      continue;
    }
    i++;
  }
  return src.slice(start);
}

function check(file: string, src: string): Finding[] {
  const findings: Finding[] = [];
  for (const tag of WRAPPER_TAGS) {
    const startRe = new RegExp(`<${tag}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = startRe.exec(src))) {
      const block = extractElement(src, m.index);
      // the scan continues after this element, not just after the opening tag
      startRe.lastIndex = m.index + block.length;

      const isRowTag = tag === 'Row';
      const typeMatch = /type\s*=\s*['"](toggle|value)['"]/.exec(block);
      if (isRowTag && !typeMatch) {
        continue; // type='screen' or unreadable - navigation, not a setting
      }
      const isValueWithPreload = typeMatch?.[1] === 'value' && /\bpreload\s*=/.test(block);
      if (isValueWithPreload) {
        continue; // a value row that navigates to another route
      }
      const explained = /onExplain\s*=/.test(block) || /\{\.\.\.explainProps\(/.test(block);
      if (!explained && !hasExemptionComment(src, m.index)) {
        findings.push({ file, snippet: block.replace(/\s+/g, ' ').slice(0, 140) });
      }
    }
  }
  return findings;
}

describe('every settings toggle/value row can explain itself', () => {
  it('has no Row(toggle|value) without onExplain, explainProps, or a documented no-explain', () => {
    const files = readdirSync(settingsDir).filter(
      f => f.endsWith('.tsx') && !f.endsWith('.test.tsx'),
    );
    const findings = files.flatMap(f => check(f, readFileSync(join(settingsDir, f), 'utf8')));
    if (findings.length > 0) {
      const msg = findings.map(f => `${f.file}: ${f.snippet}`).join('\n');
      throw new Error(`rows missing an explanation:\n${msg}`);
    }
    expect(findings).toEqual([]);
  });
});
