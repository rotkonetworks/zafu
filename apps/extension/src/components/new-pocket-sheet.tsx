/**
 * new pocket / rename - one small sheet, two modes. Creating names a fresh
 * ZIP 32 account and gives it the chain tip as its birthday (a pocket has no
 * history to scan back through, so starting it at "now" keeps first sync
 * fast - see state/pockets.ts). Renaming only ever touches a name, and the
 * caller decides whose: a pocket's or the active wallet's (accounts-sheet.tsx
 * passes `save`, so this sheet stays agnostic to what it is renaming).
 */

import { useEffect, useState } from 'react';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { useStore } from '../state';
import { selectActiveNetwork, selectEffectiveKeyInfo } from '../state/keyring';
import { MAX_POCKETS, pocketOwner, pocketsOf } from '../state/pockets';
import { ZidecarClient } from '../state/keyring/zidecar-client';
import { LightwalletdClient } from '../state/keyring/lightwalletd-client';
import { pocketTarget, type PocketSheetTarget } from './accounts-sheet';
import { fmtZec } from '../routes/popup/home/format';

export const NewPocketSheet = ({
  open,
  onOpenChange,
  rename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** set to rename instead of creating a pocket */
  rename?: PocketSheetTarget;
}) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const book = useStore(s => s.pockets.book);
  const add = useStore(s => s.pockets.add);
  const target = pocketTarget(useStore(selectActiveNetwork));
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const zcashBackend = useStore(s => s.networks.networks.zcash.backend) ?? 'zidecar';

  const owner = selectedKeyInfo ? pocketOwner(selectedKeyInfo) : undefined;
  const existing = owner ? pocketsOf(book, owner) : [];
  const nextAccount = existing.length > 0 ? Math.max(...existing.map(p => p.account)) + 1 : 1;
  const atLimit = !rename && existing.length >= MAX_POCKETS;

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [holds, setHolds] = useState<string>();

  // reset the form each time the sheet opens, prefilling the current name
  // when renaming
  useEffect(() => {
    if (open) {
      setName(rename?.name ?? '');
      setBusy(false);
      setError(null);
    }
  }, [open, rename]);

  // a hideable pocket may hold funds: say so in one line rather than silently
  // hiding money away
  useEffect(() => {
    if (!open || !rename?.pocket || !selectedKeyInfo || !target.balance) {
      setHolds(undefined);
      return;
    }
    let cancelled = false;
    target
      .balance(selectedKeyInfo.id, rename.pocket.account)
      .then(bal => {
        if (!cancelled && bal > 0n) {
          setHolds(fmtZec(Number(bal) / 1e8));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, rename, selectedKeyInfo, target]);

  const handleHide = async () => {
    if (!rename?.pocket || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rename.pocket.hide();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not hide this pocket');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async () => {
    if (busy) {
      return;
    }
    if (rename) {
      // empty restores the old name: just close without saving
      const trimmed = name.trim();
      if (!trimmed || trimmed === rename.name) {
        onOpenChange(false);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await rename.save(trimmed);
        onOpenChange(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'could not rename this');
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!owner || atLimit) {
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
      await target.pick(useStore.getState(), owner, account);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not create this pocket');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={rename ? 'rename' : 'new pocket'}>
      {atLimit ? (
        <p className='text-label text-fg-muted lowercase'>
          this wallet has {MAX_POCKETS} pockets, the most it can hold.
        </p>
      ) : (
        <div className='flex flex-col gap-3'>
          <label htmlFor='new-pocket-name' className='text-label text-fg-muted lowercase'>
            name
          </label>
          <Input
            id='new-pocket-name'
            type='text'
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            autoFocus
            placeholder={rename ? undefined : `pocket ${nextAccount}`}
          />
          {error && <p className='text-label text-hanko-light lowercase'>{error}</p>}
          <Button
            onClick={() => void handleSubmit()}
            loading={busy}
            disabled={rename ? busy : !owner}
          >
            {rename ? 'rename' : 'create pocket'}
          </Button>
          {rename?.pocket && (
            <>
              {holds && (
                <p className='text-label text-fg-muted lowercase'>
                  it still holds {holds} zec · it stays yours
                </p>
              )}
              <Button variant='quiet' onClick={() => void handleHide()} disabled={busy}>
                hide this pocket
              </Button>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
};

export default NewPocketSheet;
