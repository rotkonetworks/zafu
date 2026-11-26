/**
 * The page-world evm provider: announced through EIP-6963, never in the way
 * of a wallet that already holds window.ethereum, and failing with the
 * EIP-1193 code the bridge sent.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

const announced: { info: { rdns: string; name: string; icon: string }; provider: unknown }[] = [];
window.addEventListener('eip6963:announceProvider', e =>
  announced.push((e as CustomEvent).detail as (typeof announced)[number]),
);

const load = async () => {
  vi.resetModules();
  announced.length = 0;
  await import('./injected-evm');
};

afterEach(() => {
  delete (window as { ethereum?: unknown }).ethereum;
});

describe('injected-evm', () => {
  test('announces zafu, and again when asked', async () => {
    await load();
    expect(announced[0]?.info).toMatchObject({ rdns: 'net.rotko.zafu', name: 'Zafu' });
    // vitest leaves the asset a path; the build inlines it (webpack `?inline`)
    expect(announced[0]?.info.icon).toContain('icon32.png');
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    expect(announced.length).toBeGreaterThan(1);
  });

  const fromBridge = (data: Record<string, unknown>) =>
    window.dispatchEvent(
      new MessageEvent('message', { data: { channel: 'zafu-evm', ...data }, source: window }),
    );

  test('leaves window.ethereum alone unless the person turned it on', async () => {
    await load();
    expect('ethereum' in window).toBe(false);
    fromBridge({ direction: 'ethereum' });
    // providers loaded by earlier tests listen too, so the slot holds one of zafu's
    expect((window as { ethereum?: { isZafu?: boolean } }).ethereum?.isZafu).toBe(true);
  });

  test('never takes window.ethereum from another wallet', async () => {
    const other = { isMetaMask: true };
    (window as { ethereum?: unknown }).ethereum = other;
    await load();
    fromBridge({ direction: 'ethereum' });
    expect((window as { ethereum?: unknown }).ethereum).toBe(other);
  });

  test("passes on the worker's chain change to the page", async () => {
    await load();
    const provider = announced[0]!.provider as {
      request: (a: { method: string }) => Promise<unknown>;
      on: (e: string, l: (v: unknown) => void) => void;
    };
    const post = vi.spyOn(window, 'postMessage').mockImplementationOnce(data => {
      const { id } = data as { id: string };
      fromBridge({ direction: 'response', id, ok: true, result: '0x38' });
    });
    await provider.request({ method: 'eth_chainId' });
    post.mockRestore();
    const changed = vi.fn();
    provider.on('chainChanged', changed);
    fromBridge({ direction: 'event', event: 'chainChanged', value: '0x61' });
    expect(changed).toHaveBeenCalledWith('0x61');
  });

  test('rejects with the code the bridge sent', async () => {
    await load();
    const provider = announced[0]!.provider as {
      request: (a: { method: string }) => Promise<unknown>;
    };
    const post = vi.spyOn(window, 'postMessage').mockImplementationOnce(data => {
      const { id } = data as { id: string };
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            channel: 'zafu-evm',
            direction: 'response',
            id,
            ok: false,
            error: 'no',
            code: 4001,
          },
          source: window,
        }),
      );
    });
    await expect(provider.request({ method: 'eth_requestAccounts' })).rejects.toMatchObject({
      code: 4001,
    });
    post.mockRestore();
  });

  test('passes on a wallet switch that took the accounts away', async () => {
    await load();
    const provider = announced[0]!.provider as {
      request: (a: { method: string }) => Promise<unknown>;
      on: (e: string, l: (v: unknown) => void) => void;
    };
    const post = vi.spyOn(window, 'postMessage').mockImplementationOnce(data => {
      const { id } = data as { id: string };
      fromBridge({ direction: 'response', id, ok: true, result: ['0xaa'] });
    });
    await provider.request({ method: 'eth_accounts' });
    post.mockRestore();
    const changed = vi.fn();
    provider.on('accountsChanged', changed);
    fromBridge({ direction: 'event', event: 'accountsChanged', value: [] });
    expect(changed).toHaveBeenCalledWith([]);
  });
});
