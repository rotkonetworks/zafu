/**
 * A pasted viewing key, read the way settings and onboarding both need: what
 * it is, whether it decodes, and the address it belongs to, so the person
 * sees which wallet this is before anything is stored. Decoding is local
 * wasm; nothing is fetched.
 */

import { useEffect, useMemo, useState } from 'react';
import { fixOrchardAddress } from '@repo/wallet/networks/zcash/unified-address';
import type { ZignerZafuImport } from '../state/keyring/types';
import { classifyViewingKey, viewingKeyDeviceId, type ViewingKeyKind } from '../utils/viewing-key';
import { shorten } from '@repo/ui/lib/utils';

interface Zwasm {
  default?: (opts?: { module_or_path?: string }) => Promise<unknown>;
  validate_ufvk: (s: string) => boolean;
  address_from_ufvk: (s: string, diversifierIndex: number) => string;
}

const decode = async (key: string): Promise<string> => {
  const zwasm = (await import('@repo/zcash-wasm')) as unknown as Zwasm;
  if (typeof zwasm.default === 'function') {
    await zwasm.default();
  }
  if (!zwasm.validate_ufvk(key)) {
    throw new Error('does not decode');
  }
  // the wasm hands back raw orchard bytes; encode them as the unified address
  return fixOrchardAddress(zwasm.address_from_ufvk(key, 0), !key.startsWith('uviewtest'));
};

const REFUSED: Partial<Record<ViewingKeyKind['kind'], string>> = {
  seed: 'this is a recovery phrase · please never paste it here',
  spending_key: 'this is a spending key · please never paste it here',
  uivk: 'an incoming key cannot see spends · please paste the full key (uview1...)',
  sapling: 'a sapling key · zafu needs a unified key (uview1...)',
  unknown: 'not a zcash viewing key',
};

export interface ViewingKeyRead {
  /** the decoded key and its first address, once both are known */
  ok?: { key: string; address: string; mainnet: boolean };
  /** one line for the note under the field; bad marks a refusal */
  note?: { text: string; bad: boolean };
}

export const useViewingKey = (input: string): ViewingKeyRead => {
  const detected = useMemo(() => classifyViewingKey(input), [input]);
  const key = detected.kind === 'ufvk' ? detected.key : undefined;
  // keyed by the key it answers, so a stale answer never shows for a new paste
  const [decoded, setDecoded] = useState<{ key: string; address?: string; error?: string }>();

  useEffect(() => {
    if (!key) {
      return;
    }
    let live = true;
    decode(key)
      .then(address => live && setDecoded({ key, address }))
      .catch((e: unknown) => {
        const orchard = String(e instanceof Error ? e.message : e).includes('orchard');
        if (live) {
          setDecoded({
            key,
            error: orchard
              ? 'this key has no orchard part, which zafu needs to sync'
              : 'this key does not decode · please check it was copied in full',
          });
        }
      });
    return () => {
      live = false;
    };
  }, [key]);

  if (detected.kind === 'empty') {
    return {};
  }
  if (detected.kind !== 'ufvk') {
    return { note: { text: REFUSED[detected.kind] ?? REFUSED.unknown!, bad: true } };
  }
  const answer = decoded?.key === detected.key ? decoded : undefined;
  if (answer?.error) {
    return { note: { text: answer.error, bad: true } };
  }
  if (!answer?.address) {
    return { note: { text: 'reading the key...', bad: false } };
  }
  const net = detected.mainnet ? '' : ' (testnet)';
  return {
    ok: { key: detected.key, address: answer.address, mainnet: detected.mainnet },
    note: { text: `full viewing key${net} · ${shorten(answer.address, 16, 8)}`, bad: false },
  };
};

/** a watch-only wallet: no signer, so zafu never offers it a send */
export const viewingKeyImport = async (key: string): Promise<ZignerZafuImport> => ({
  viewingKey: key,
  accountIndex: 0,
  deviceId: await viewingKeyDeviceId(key),
  coldSignerType: 'viewing-key',
});
