/**
 * Getting USDC onto Hyperliquid: the account's own address (another
 * Hyperliquid account can send straight to it), and the Arbitrum bridge with
 * its rules said plainly, since a deposit that breaks them is lost.
 */

import { useState } from 'react';
import { shorten } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { useCopy } from '@repo/ui/hooks/use-copy';
import { HYPERLIQUID_BRIDGE, HYPERLIQUID_MIN_DEPOSIT } from '@repo/wallet/networks/hyperliquid/api';
import { microToUsdc } from '@repo/wallet/networks/hyperliquid/client';
import { useHyperliquidAccount } from '../../../hooks/hyperliquid';
import { Facts } from '../send/send-ui';
import { AddressView } from './address-view';

const MIN = microToUsdc(HYPERLIQUID_MIN_DEPOSIT);

export const HyperliquidDeposit = () => {
  const { keyId, address } = useHyperliquidAccount();
  const [bridge, setBridge] = useState(false);
  const own = useCopy();
  const toBridge = useCopy();

  if (!keyId) {
    return (
      <StatusSlot icon='i-ph-info'>
        hyperliquid needs a seed wallet in zafu for now · this wallet&apos;s keys stay on its signer
      </StatusSlot>
    );
  }
  return (
    <>
      <AddressView
        address={address ?? ''}
        loading={!address}
        label='hyperliquid address · public'
        hint='usdc from another hyperliquid account'
        tone='public'
      >
        <Button variant='secondary' onClick={() => setBridge(true)} className='w-[150px] shrink-0'>
          from arbitrum
        </Button>
        <Button onClick={() => address && own.copy(address)} disabled={!address} className='flex-1'>
          {own.copied ? 'copied' : 'copy address'}
        </Button>
      </AddressView>
      <Sheet
        open={bridge}
        onOpenChange={setBridge}
        title='deposit from arbitrum'
        footer={
          <Button className='w-full' onClick={() => toBridge.copy(HYPERLIQUID_BRIDGE)}>
            {toBridge.copied ? 'copied' : 'copy bridge address'}
          </Button>
        }
      >
        <Facts
          rows={[
            ['send', 'usdc on arbitrum one'],
            ['from', address ? `your address ${shorten(address, 6, 4)}` : 'your address'],
            ['minimum', `${MIN} usdc`],
            ['arrives in', 'about a minute'],
          ]}
        />
        <div className='flex flex-col gap-1.5'>
          <span className='text-xs text-fg-muted'>to hyperliquid&apos;s bridge</span>
          <span className='break-all font-mono text-xs text-fg-high'>{HYPERLIQUID_BRIDGE}</span>
        </div>
        <StatusSlot tone='warn' icon='i-ph-warning'>
          hyperliquid credits the address that sends. send from your own address above, never
          straight from an exchange · less than {MIN} usdc, or any other coin or network, is lost ·
          zafu cannot send on arbitrum yet
        </StatusSlot>
      </Sheet>
    </>
  );
};
