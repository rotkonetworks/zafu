/**
 * The MAIN-world script gets our extension id from the ISOLATED session script
 * through a same-stack event pair, never through the page's DOM, where CSS
 * selectors and session-replay snapshots could read it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PenumbraSymbol } from '@penumbra-zone/client/symbol';
import { answerExtensionId } from './message/extension-id';

const providerFor = (extensionId: string) => {
  const global = (window as unknown as Record<symbol, Record<string, { manifest: string }>>)[
    PenumbraSymbol
  ];
  return global?.[`chrome-extension://${extensionId}`];
};

describe('injected-penumbra-global', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  test('injects the provider for the id the session script answers with', async () => {
    answerExtensionId('bhlogefpcebekhjpomlodifcelldoimn');

    await import('./injected-penumbra-global');

    expect(providerFor('bhlogefpcebekhjpomlodifcelldoimn')?.manifest).toBe(
      'chrome-extension://bhlogefpcebekhjpomlodifcelldoimn/manifest.json',
    );
    expect(document.documentElement.attributes).toHaveLength(0);
  });

  test('skips injection when no session script answers', async () => {
    const before = Object.keys(
      (window as unknown as Record<symbol, object | undefined>)[PenumbraSymbol] ?? {},
    );

    await import('./injected-penumbra-global');

    expect(
      Object.keys((window as unknown as Record<symbol, object | undefined>)[PenumbraSymbol] ?? {}),
    ).toEqual(before);
  });
});
