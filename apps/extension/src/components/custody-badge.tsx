import { cn } from '@repo/ui/lib/utils';
import type { KeyInfo } from '../state/keyring';
import { walletKind, type WalletKind } from '../signing/wallet-kind';

/**
 * custody indicator - where the spending key actually lives.
 *
 * This is the single most consequential fact about a wallet and it was
 * previously invisible: the picker showed only a name, so "savings" and
 * "savings (zigner)" looked identical right up until you tried to send.
 *
 * Four states, because fewer would be a lie:
 *
 *   hot      the spending key is in this browser, encrypted under your
 *            password. zafu can sign on its own.
 *   cold     the key has never been here. zafu holds a viewing key, builds
 *            the transaction, and the signature comes back over QR or USB.
 *   shared   a FROST threshold share. Neither hot nor cold - this share
 *            alone cannot spend, and co-signers must approve.
 *   watching a viewing key and no signer: it sees, never spends.
 *
 * Deliberately not alarming. Hot custody is the normal, useful state for a
 * spending wallet; painting it red would train people to ignore red. The
 * warm/cool split carries the meaning and the hanko red stays reserved for
 * things that are actually wrong.
 */

export type Custody = 'hot' | 'cold' | 'shared' | 'watching';

/** read from the signer the vault holds now, so a viewing key a signer joined reads cold */
const CUSTODY: Record<WalletKind, Custody> = {
  hot: 'hot',
  zigner: 'cold',
  keystone: 'cold',
  'ledger-shielded': 'cold',
  'ledger-transparent': 'cold',
  'frost-self': 'shared',
  'frost-airgap': 'shared',
  'viewing-key': 'watching',
  // a signer zafu does not know is still somewhere other than here
  unknown: 'cold',
};

export const custodyOf = (vault: Pick<KeyInfo, 'type' | 'insensitive'>): Custody =>
  CUSTODY[walletKind(vault)];

const STYLE: Record<Custody, { icon: string; tint: string; title: string }> = {
  hot: {
    icon: 'i-zafu-hi',
    tint: 'text-zigner-gold/90 bg-zigner-gold/10',
    title: 'hot - the spending key is in this browser, encrypted under your password',
  },
  cold: {
    icon: 'i-zafu-kori',
    tint: 'text-device-blue bg-device-blue/10',
    title: 'cold - the spending key never touches this browser; signing happens on your device',
  },
  shared: {
    icon: 'i-zafu-torii',
    tint: 'text-fg-muted bg-elev-2',
    title: 'shared - a threshold share; co-signers must approve before this can spend',
  },
  watching: {
    icon: 'i-ph-eye',
    tint: 'text-fg-muted bg-elev-2',
    title: 'watching - a viewing key; it sees this wallet but cannot spend',
  },
};

export const CustodyBadge = ({
  vault,
  showLabel = true,
  className,
}: {
  vault: Pick<KeyInfo, 'type' | 'insensitive'>;
  /** icon-only in tight rows (the header picker); icon + word elsewhere */
  showLabel?: boolean;
  className?: string;
}) => {
  const custody = custodyOf(vault);
  const style = STYLE[custody];

  // for a threshold vault the ratio *is* the useful label - "2/3" says more
  // than the word "shared" ever could.
  const threshold = vault.insensitive['threshold'];
  const maxSigners = vault.insensitive['maxSigners'];
  const label =
    custody === 'shared' && threshold && maxSigners
      ? `${String(threshold)}/${String(maxSigners)}`
      : custody;

  return (
    <span
      title={style.title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-label lowercase',
        style.tint,
        className,
      )}
    >
      <span className={cn(style.icon, 'size-3')} />
      {showLabel && <span>{label}</span>}
    </span>
  );
};
