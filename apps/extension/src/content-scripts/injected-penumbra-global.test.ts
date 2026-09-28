/**
 * The MAIN-world content script is the one script in the extension that runs on
 * arbitrary documents, and it reads the bridge id off the DOM root. On a
 * non-HTML document (a top-level `.xml`/`.svg` response, or a viewer page
 * served as XML) `documentElement` is a bare `Element` with no `dataset`, so
 * reading `documentElement.dataset[..]` throws an uncaught TypeError that kills
 * this script on every such page. These tests pin the attribute read against
 * exactly that shape of root.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PenumbraSymbol } from '@penumbra-zone/client/symbol';

const ID_ATTRIBUTE = 'data-zafu-extension-id';

/** a document root shaped like an XML/SVG document's: an Element, no `dataset` */
const elementRoot = (attribute: string | null) => ({
  getAttribute: (name: string) => (name === ID_ATTRIBUTE ? attribute : null),
});

const importWithRoot = async (documentElement: unknown) => {
  vi.stubGlobal('document', {
    prerendering: false,
    addEventListener: () => {},
    documentElement,
  });
  await import('./injected-penumbra-global');
};

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
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  test('injects the provider on a document root that has no dataset', async () => {
    const root = elementRoot('bhlogefpcebekhjpomlodifcelldoimn');
    expect('dataset' in root).toBe(false);

    await importWithRoot(root);

    expect(providerFor('bhlogefpcebekhjpomlodifcelldoimn')?.manifest).toBe(
      'chrome-extension://bhlogefpcebekhjpomlodifcelldoimn/manifest.json',
    );
  });

  test('skips injection when the bridge attribute is absent', async () => {
    await importWithRoot(elementRoot(null));

    expect(providerFor('absent')).toBeUndefined();
  });

  test('skips injection for the orphaned chrome.runtime.id', async () => {
    await importWithRoot(elementRoot('invalid'));

    expect(providerFor('invalid')).toBeUndefined();
  });

  test('survives a document with no documentElement', async () => {
    await importWithRoot(null);

    expect(providerFor('anything')).toBeUndefined();
  });
});
