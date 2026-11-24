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
import { selectZcashBackend, selectZcashEndpoint } from '../state/networks';
import { selectActiveNetwork, selectEffectiveKeyInfo } from '../state/keyring';
import { pocketOwner, pocketsOf, zignerPockets } from '../state/pockets';
import { parseZcashUr } from '@repo/wallet/ur-parser';
import { QrScanner } from '../shared/components/qr-scanner';
import { zcashClient } from '../state/keyring/zcash-backend';
import { pocketTarget, type PocketSheetTarget } from './accounts-sheet';
import { zcashWorkerQuery } from '../hooks/zcash-pool-balances';
import { useQuery } from '@tanstack/react-query';
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
  const zidecarUrl = useStore(selectZcashEndpoint);
  const zcashBackend = useStore(selectZcashBackend);
  // a zigner wallet's pocket is an account whose viewing key the device shows
  const zigner = useStore(s => !!zignerPockets(s));
  const addZignerPocket = useStore(s => s.wallets.addZignerPocket);
  const [scanning, setScanning] = useState(false);
  // the camera's visible fallback, as on every signer scan
  const [pasted, setPasted] = useState('');

  const owner = selectedKeyInfo ? pocketOwner(selectedKeyInfo) : undefined;
  const existing = owner ? pocketsOf(book, owner) : [];
  const nextAccount = existing.length > 0 ? Math.max(...existing.map(p => p.account)) + 1 : 1;

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
      setScanning(false);
      setPasted('');
    }
  }, [open, rename]);

  // a hideable pocket may hold funds: say so in one line rather than silently
  // hiding money away
  const pocketStore =
    rename?.pocket && selectedKeyInfo && target.store
      ? target.store(selectedKeyInfo.id, rename.pocket.account)
      : undefined;
  const { data: pocketZat } = useQuery({
    ...zcashWorkerQuery.balance(pocketStore),
    enabled: open && !!pocketStore,
  });
  const holds = pocketStore && pocketZat ? fmtZec(Number(pocketZat) / 1e8) : undefined;

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

  // the pocket's birthday: the tip, so its first sync is quick
  const tipNow = () =>
    zcashClient(zidecarUrl, zcashBackend)
      .getTip()
      .then(t => t.height)
      .catch(() => undefined);

  const handleZignerKey = async (raw: string) => {
    if (!selectedKeyInfo || !owner || busy) {
      return;
    }
    setScanning(false);
    setBusy(true);
    setError(null);
    try {
      const scanned = parseZcashUr(raw.trim());
      const account = await addZignerPocket(selectedKeyInfo.id, scanned, name, await tipNow());
      await target.pick(useStore.getState(), owner, account);
      onOpenChange(false);
    } catch (e) {
      setError(
        e instanceof Error && !/^expected ur:|cbor|ufvk/i.test(e.message)
          ? e.message
          : "that isn't a zigner viewing key · please show the zcash key on zigner",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async () => {
    if (busy) {
      return;
    }
    if (zigner && !rename) {
      setScanning(true);
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
    if (!owner) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // best-effort: a pocket still creates fine without a tip, it just
      // scans from the wallet birthday instead of from now.
      const account = await add(owner, name, await tipNow());
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
        {zigner && !rename && (
          <p className='text-label text-fg-muted lowercase'>
            on zigner: zcash key · account {nextAccount} · scan its viewing key
          </p>
        )}
        {scanning && (
          <>
            <QrScanner
              inline
              onScan={raw => void handleZignerKey(raw)}
              onError={e => setError(e)}
              onClose={() => setScanning(false)}
            />
            <Input
              aria-label='or paste the code'
              placeholder='or paste the code'
              value={pasted}
              onChange={e => setPasted(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && pasted.trim()) {
                  e.preventDefault();
                  void handleZignerKey(pasted);
                }
              }}
            />
          </>
        )}
        {error && <p className='text-label text-hanko-light lowercase'>{error}</p>}
        <Button
          onClick={() => void handleSubmit()}
          loading={busy}
          disabled={rename ? busy : !owner || scanning}
        >
          {rename ? 'rename' : zigner ? 'scan zigner' : 'create pocket'}
        </Button>
        {rename?.pocket && (
          <>
            {holds && (
              <p className='text-label text-fg-muted lowercase'>
                it still has {holds} zec · it stays yours
              </p>
            )}
            <Button variant='quiet' onClick={() => void handleHide()} disabled={busy}>
              hide this pocket
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
};

export default NewPocketSheet;
