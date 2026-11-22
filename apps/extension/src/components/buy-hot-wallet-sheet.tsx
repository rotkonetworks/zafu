/**
 * Buy zec signs with a recovery phrase on this computer. With a cold wallet
 * selected, a buy entry raises this sheet in place instead of opening a whole
 * tab that can only say so. Mounted once at the popup root (see setBuyGate).
 */

import { useEffect, useState } from 'react';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state';
import { selectSwitcherKeyInfos } from '../state/keyring';
import { keyInfoSupportsNetwork } from '../state/keyring/vault-ops';
import { openBuyPage, setBuyGate } from '../buy/open';

export const BuyHotWalletSheet = () => {
  const [open, setOpen] = useState(false);
  // a phrase wallet that holds zcash: a penumbra-only phrase can't receive the zec
  const hot = useStore(
    useShallow(s =>
      selectSwitcherKeyInfos(s).filter(
        k => k.type === 'mnemonic' && keyInfoSupportsNetwork(k, 'zcash'),
      ),
    ),
  );
  const selectKeyRing = useStore(s => s.keyRing.selectKeyRing);

  useEffect(
    () =>
      setBuyGate(() => {
        const cold = useStore.getState().keyRing.selectedKeyInfo?.type !== 'mnemonic';
        setOpen(cold);
        return cold;
      }),
    [],
  );

  const use = async (id: string) => {
    await selectKeyRing(id);
    setOpen(false);
    openBuyPage();
  };

  return (
    <Sheet open={open} onOpenChange={setOpen} title='buying needs a phrase wallet'>
      <div className='flex flex-col gap-4 px-1 text-sm text-fg-muted lowercase'>
        <p>
          buy zec signs with a wallet whose recovery phrase is on this computer. this wallet signs
          elsewhere.
        </p>
        {hot.map(k => (
          <Button key={k.id} variant='secondary' onClick={() => void use(k.id)}>
            use {k.name}
          </Button>
        ))}
        <Button variant='quiet' onClick={() => setOpen(false)}>
          not now
        </Button>
      </div>
    </Sheet>
  );
};
