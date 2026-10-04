/**
 * "shared" on home (Cv2Home): every shared wallet this wallet holds a seat
 * in - groups, deals and other multisigs - with its balance, and never in the
 * total above it. A seat made in a room opens that room; another opens as
 * the active wallet, as before.
 */

import { useNavigate } from 'react-router-dom';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { useStore } from '../../../state';
import { privacySelector } from '../../../state/privacy';
import { selectSelectKeyRing } from '../../../state/keyring';
import { selectZcashWallets, type ZcashWalletJson } from '../../../state/wallets';
import { useSharedBalance } from '../../../hooks/use-shared-balance';
import { contactPath, groupPath } from '../paths';
import { fmtZecHero } from './format';

const glyph = (w: ZcashWalletJson) =>
  w.multisig?.room?.roomId.startsWith('p:') ? '契' : w.multisig?.room ? '工' : '蔵';

const SharedRow = ({ w }: { w: ZcashWalletJson }) => {
  const navigate = useNavigate();
  const selectKeyRing = useStore(selectSelectKeyRing);
  const hide = useStore(s => privacySelector(s).settings.hideBalances);
  const zat = useSharedBalance(w);
  const ms = w.multisig!;
  const room = ms.room?.roomId;
  return (
    <Row
      type='value'
      media={
        <span className='grid size-8 shrink-0 place-items-center border border-border-hard font-display text-sm text-zigner-gold'>
          {glyph(w)}
        </span>
      }
      label={w.label}
      description={`${ms.threshold} of ${ms.maxSigners}`}
      value={hide ? '•••••' : zat === undefined ? '…' : fmtZecHero(Number(zat) / 1e8)}
      onPress={() =>
        room?.startsWith('g:')
          ? navigate(groupPath(room.slice(2)))
          : room?.startsWith('p:')
            ? navigate(contactPath(room.slice(2)))
            : void selectKeyRing(w.vaultId)
      }
    />
  );
};

export const SharedWallets = () => {
  const wallets = useStore(selectZcashWallets);
  const walletId = useStore(s => s.keyRing.selectedKeyInfo?.id);
  // a room's seat shows under the wallet whose room it is; others everywhere, as before
  const shared = wallets.filter(
    w =>
      w.multisig &&
      !w.multisig.hidden &&
      w.vaultId !== walletId &&
      (!w.multisig.room || w.multisig.room.walletId === walletId),
  );
  if (!shared.length) {
    return null;
  }
  return (
    <section className='flex flex-col gap-1.5'>
      <div className='flex items-baseline justify-between px-0.5'>
        <h2 className='text-xs text-fg-muted'>shared</h2>
        <span className='text-[11px] text-fg-dim'>not in your total</span>
      </div>
      <RowGroup>
        {shared.map(w => (
          <SharedRow key={w.id} w={w} />
        ))}
      </RowGroup>
    </section>
  );
};
