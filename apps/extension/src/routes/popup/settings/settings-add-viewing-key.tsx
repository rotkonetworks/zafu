/**
 * Add a wallet from a pasted viewing key.
 *
 * A viewing key shows everything a wallet receives and spends, and can never
 * spend. The screen says exactly that, tells the user what they pasted (and
 * refuses seeds and spending keys outright), shows the address the key
 * belongs to before anything is stored, and adds a watch-only wallet with no
 * signer - so zafu never offers it a send.
 */

import { useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { cn } from '@repo/ui/lib/utils';
import { useStore } from '../../../state';
import { keyRingSelector } from '../../../state/keyring';
import { ZCASH_ORCHARD_ACTIVATION } from '../../../config/networks';
import { describeZcashHeight } from '../../../utils/zcash-blocks';
import { useViewingKey, viewingKeyImport } from '../../../hooks/use-viewing-key';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { Clipped } from '@repo/ui/components/ui/clipped';

export const SettingsAddViewingKey = () => {
  const navigate = usePopupNav();
  const { addZignerUnencrypted } = useStore(keyRingSelector);

  const [input, setInput] = useState('');
  const [label, setLabel] = useState('');
  const [startBlock, setStartBlock] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { ok, note: verdict } = useViewingKey(input);
  const address = ok?.address;

  const startBlockNum = parseInt(startBlock, 10);
  const startBlockHint = startBlock.trim() ? describeZcashHeight(startBlockNum) : null;
  const startBlockOk = !startBlock.trim() || (startBlockHint?.ok ?? false);

  const canAdd = !!ok && startBlockOk && !adding;

  const add = async () => {
    if (!ok) {
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const vaultId = await addZignerUnencrypted(
        await viewingKeyImport(ok.key),
        label.trim() || 'viewing key',
      );
      // Blank = the whole history since orchard activation. Slower the first
      // time, but a viewing key is usually for a wallet that already has
      // history, and starting at the tip would silently show it empty.
      const height = startBlock.trim()
        ? Math.max(ZCASH_ORCHARD_ACTIVATION, startBlockNum)
        : ZCASH_ORCHARD_ACTIVATION;
      await chrome.storage.local.set({ [`zcashBirthday_${vaultId}`]: height });
      navigate(PopupPath.SETTINGS_WALLETS);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <SettingsScreen title='add viewing key' backPath={PopupPath.SETTINGS_WALLETS}>
      <div className='flex flex-col gap-4 px-4'>
        <p className='text-xs text-fg-muted lowercase'>
          a viewing key shows every payment this wallet receives and makes. it cannot spend. anyone
          who has it can see the same, so share it like a password.
        </p>

        <div className='flex flex-col gap-1.5'>
          <label htmlFor='vk' className='text-label text-fg-muted lowercase'>
            viewing key
          </label>
          <textarea
            id='vk'
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder='uview1...'
            rows={4}
            spellCheck={false}
            autoComplete='off'
            className='w-full resize-none border border-border-soft bg-elev-1 p-2 font-mono text-[11px] leading-snug text-fg-high outline-none focus:border-fg-muted'
          />
          {verdict && (
            <p className={cn('text-label lowercase', verdict.bad ? 'text-hanko' : 'text-fg-dim')}>
              {verdict.text}
            </p>
          )}
        </div>

        {address && (
          <div className='flex flex-col gap-1 border border-border-soft bg-elev-1 p-3'>
            <span className='text-label text-fg-dim lowercase'>this key belongs to</span>
            <Clipped head={16} tail={8} label='address' className='font-mono text-xs text-fg-high'>
              {address}
            </Clipped>
          </div>
        )}

        {address && (
          <>
            <div className='flex flex-col gap-1.5'>
              <label htmlFor='vk-label' className='text-label text-fg-muted lowercase'>
                name
              </label>
              <Input
                id='vk-label'
                placeholder='viewing key'
                value={label}
                onChange={e => setLabel(e.target.value)}
              />
            </div>

            <div className='flex flex-col gap-1.5'>
              <label htmlFor='vk-start' className='text-label text-fg-muted lowercase'>
                start block (optional)
              </label>
              <Input
                id='vk-start'
                type='text'
                inputMode='numeric'
                placeholder='e.g. 2910104'
                value={startBlock}
                onChange={e => setStartBlock(e.target.value)}
                className='font-mono text-xs'
              />
              <p
                className={cn(
                  'text-label lowercase',
                  startBlockHint && !startBlockHint.ok ? 'text-hanko' : 'text-fg-dim',
                )}
              >
                {startBlockHint
                  ? startBlockHint.text
                  : 'blank scans the whole history - slow the first time. a block from around when the wallet was made is much faster.'}
              </p>
            </div>
          </>
        )}

        {error && <p className='text-xs text-hanko lowercase'>{error}</p>}

        <Button variant='primary' disabled={!canAdd} onClick={() => void add()}>
          {adding ? 'adding...' : 'add watch-only wallet'}
        </Button>
      </div>
    </SettingsScreen>
  );
};
