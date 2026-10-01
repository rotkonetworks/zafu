/**
 * new pocket / rename pocket - one small sheet, two modes. Creating names a
 * fresh ZIP 32 account and gives it the chain tip as its birthday (a pocket
 * has no history to scan back through, so starting it at "now" keeps first
 * sync fast - see state/pockets.ts). Renaming only ever touches the name.
 */

import { useEffect, useState } from 'react';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { useStore } from '../state';
import { selectEffectiveKeyInfo } from '../state/keyring';
import { MAX_POCKETS, pocketOwner, pocketsOf } from '../state/pockets';
import { ZidecarClient } from '../state/keyring/zidecar-client';
import { LightwalletdClient } from '../state/keyring/lightwalletd-client';
import type { PocketSheetTarget } from './accounts-sheet';

export const NewPocketSheet = ({
  open,
  onOpenChange,
  rename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** set to rename that pocket instead of creating a new one */
  rename?: PocketSheetTarget;
}) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const book = useStore(s => s.pockets.book);
  const add = useStore(s => s.pockets.add);
  const select = useStore(s => s.pockets.select);
  const renamePocket = useStore(s => s.pockets.rename);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const zcashBackend = useStore(s => s.networks.networks.zcash.backend) ?? 'zidecar';

  const owner = selectedKeyInfo ? pocketOwner(selectedKeyInfo) : undefined;
  const existing = owner ? pocketsOf(book, owner) : [];
  const nextAccount = existing.length > 0 ? Math.max(...existing.map(p => p.account)) + 1 : 1;
  const atLimit = !rename && existing.length >= MAX_POCKETS;

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // reset the form each time the sheet opens, prefilling the current name
  // when renaming
  useEffect(() => {
    if (open) {
      setName(rename?.name ?? '');
      setBusy(false);
      setError(null);
    }
  }, [open, rename?.account, rename?.name]);

  const handleSubmit = async () => {
    if (!owner || busy) {
      return;
    }
    if (rename) {
      setBusy(true);
      setError(null);
      try {
        await renamePocket(owner, rename.account, name);
        onOpenChange(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'could not rename this pocket');
      } finally {
        setBusy(false);
      }
      return;
    }
    if (atLimit) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client =
        zcashBackend === 'lightwalletd'
          ? new LightwalletdClient(zidecarUrl)
          : new ZidecarClient(zidecarUrl);
      // best-effort: a pocket still creates fine without a tip, it just
      // scans from the wallet birthday instead of from now.
      const tip = await client.getTip().catch(() => undefined);
      const account = await add(owner, name, tip?.height);
      await select(owner, account);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not create this pocket');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={rename ? 'rename pocket' : 'new pocket'}>
      {atLimit ? (
        <p className='text-label text-fg-muted lowercase'>
          this wallet has {MAX_POCKETS} pockets, the most it can hold.
        </p>
      ) : (
        <div className='flex flex-col gap-3'>
          <label htmlFor='new-pocket-name' className='text-label text-fg-muted lowercase'>
            name
          </label>
          <input
            id='new-pocket-name'
            type='text'
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={rename ? undefined : `pocket ${nextAccount}`}
            className='h-11 border border-surface-border bg-surface-elev-2 px-3 text-data text-fg-high placeholder:text-fg-dim focus:outline-none focus-visible:ring-1 focus-visible:ring-zigner-gold'
          />
          {!rename && (
            <p className='text-label text-fg-muted lowercase'>
              its own addresses and balance - same recovery phrase
            </p>
          )}
          {error && <p className='text-label text-hanko-light lowercase'>{error}</p>}
          <Button onClick={() => void handleSubmit()} loading={busy} disabled={!owner}>
            {rename ? 'rename pocket' : 'create pocket'}
          </Button>
        </div>
      )}
    </Sheet>
  );
};

export default NewPocketSheet;
