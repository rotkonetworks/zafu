/**
 * A signer wallet zafu holds no penumbra viewing key for. Its home would
 * otherwise read an empty penumbra view and say nothing: a zigner can show its
 * penumbra code, which joins this same wallet (by ZID), so the screen offers
 * that scan; a signer with no penumbra key at all says to pick another wallet.
 */

import { Button } from '@repo/ui/components/ui/button';
import type { KeyInfo } from '../../../state/keyring';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';

/** signers that never hold a penumbra key */
const ZCASH_ONLY = new Set(['keystone', 'ledger', 'viewing-key']);

export type PenumbraKeyGap = 'scan zigner' | 'no penumbra' | undefined;

/**
 * What this wallet lacks on penumbra, if anything. A seed phrase derives its
 * key, so only a signer wallet with no penumbra record of its own is a gap; a
 * record from before records named their wallet is trusted, as elsewhere.
 */
export const penumbraKeyGap = (
  key: KeyInfo | undefined,
  records: readonly { vaultId?: string }[],
): PenumbraKeyGap => {
  if (!key || key.type === 'mnemonic') {
    return undefined;
  }
  if (records.some(r => r.vaultId === key.id || !r.vaultId)) {
    return undefined;
  }
  const signer = key.insensitive['coldSignerType'];
  return key.type === 'zigner-zafu' && !ZCASH_ONLY.has(String(signer ?? 'zigner'))
    ? 'scan zigner'
    : 'no penumbra';
};

export const NoPenumbraKey = ({
  gap,
  name,
}: {
  gap: NonNullable<PenumbraKeyGap>;
  name: string;
}) => {
  const navigate = usePopupNav();
  return (
    <div className='flex flex-1 flex-col gap-6 px-4 pb-4 pt-6'>
      <section className='flex flex-1 flex-col items-center justify-center gap-3.5 border border-dashed border-surface-border px-6 py-10 text-center'>
        <span className='font-display text-xl text-fg-high'>no penumbra account here yet</span>
        <span className='text-[13px] text-fg-muted'>
          {gap === 'scan zigner'
            ? `${name.toLowerCase()} has no penumbra key in zafu. show its penumbra code on your zigner to add it to this wallet.`
            : `${name.toLowerCase()} has no penumbra key. pick another wallet for penumbra.`}
        </span>
        {gap === 'scan zigner' && (
          <Button
            variant='primary'
            className='h-10 px-[18px] text-[13px]'
            onClick={() => navigate(PopupPath.SETTINGS_CONNECT_DEVICE)}
          >
            scan the penumbra code
          </Button>
        )}
      </section>
    </div>
  );
};
