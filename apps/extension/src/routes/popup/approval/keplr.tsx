/**
 * Approval screen for the Keplr provider. It runs in a popup with keyring
 * access, so it is where the cosmos address is derived and where amino/direct
 * signing happens (via the tested cosmjs wallets). The service worker only
 * orchestrated getting us here; we post the result back and close.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../../../state';
import { keyRingSelector, selectEffectiveKeyInfo } from '../../../state/keyring';
import { COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import {
  deriveKeplrWireKey,
  signKeplrAmino,
  signKeplrDirect,
  type KeplrDirectWireDoc,
} from '@repo/wallet/networks/cosmos/signer';
import {
  cosmosChainIdFromKeplr,
  keplrApprovalKey,
  type KeplrApprovalRequest,
  type KeplrWireKey,
} from '../../../message/keplr';

/** prefix for a keplr chain id, from our config or a bech32 signer address */
const prefixFor = (chainId: string, signerAddress?: string): string => {
  const id = cosmosChainIdFromKeplr(chainId);
  if (id) {
    return COSMOS_CHAINS[id].bech32Prefix;
  }
  // bech32 is "<prefix>1<data>" and the data charset excludes '1', so the last
  // '1' is the separator - everything before it is the human-readable prefix
  if (signerAddress) {
    const sep = signerAddress.lastIndexOf('1');
    if (sep > 0) {
      return signerAddress.slice(0, sep);
    }
  }
  return chainId.split('-')[0] ?? 'cosmos';
};

export const KeplrApproval = () => {
  const [params] = useSearchParams();
  const requestId = params.get('requestId') ?? '';
  const { getMnemonic } = useStore(keyRingSelector);
  const keyInfo = useStore(selectEffectiveKeyInfo);

  const [req, setReq] = useState<KeplrApprovalRequest | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const key = keplrApprovalKey(requestId);
    void chrome.storage.session.get(key).then(stored => {
      const r = stored[key] as KeplrApprovalRequest | undefined;
      if (r) {
        setReq(r);
      } else {
        setLoadError('request expired');
      }
    });
  }, [requestId]);

  const chainIds = useMemo<string[]>(() => {
    const list = (req?.signDoc as { chainIds?: string[] } | undefined)?.chainIds;
    return list ?? (req ? [req.chainId] : []);
  }, [req]);

  const respond = (result: unknown) => {
    void chrome.runtime.sendMessage({ type: 'zafu_keplr_result', requestId, result });
    window.close();
  };

  const deny = () => respond({ approved: false, error: 'rejected' });

  const approve = async () => {
    if (!req || !keyInfo) {
      return;
    }
    setBusy(true);
    try {
      const mnemonic = await getMnemonic(keyInfo.id);

      if (req.method === 'enable') {
        const keys: Record<string, KeplrWireKey> = {};
        for (const cid of chainIds) {
          keys[cid] = await deriveKeplrWireKey(mnemonic, prefixFor(cid), keyInfo.name ?? 'zafu');
        }
        respond({ approved: true, payload: { keys } });
        return;
      }

      const prefix = prefixFor(req.chainId, req.signerAddress);

      if (req.method === 'signAmino') {
        const payload = await signKeplrAmino(
          mnemonic,
          prefix,
          req.signerAddress ?? '',
          req.signDoc as Parameters<typeof signKeplrAmino>[3],
        );
        respond({ approved: true, payload });
        return;
      }

      // signDirect
      const payload = await signKeplrDirect(
        mnemonic,
        prefix,
        req.signerAddress ?? '',
        req.signDoc as KeplrDirectWireDoc,
      );
      respond({ approved: true, payload });
    } catch (err) {
      respond({ approved: false, error: err instanceof Error ? err.message : 'signing failed' });
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return <div className='p-6 text-center text-sm text-red-400'>{loadError}</div>;
  }
  if (!req) {
    return <div className='p-6 text-center text-sm text-fg-muted'>loading…</div>;
  }

  const isSign = req.method === 'signAmino' || req.method === 'signDirect';
  return (
    <div className='flex h-full flex-col'>
      <header className='flex flex-col items-center justify-center border-b border-border-soft py-4'>
        <span className='kicker mb-1'>keplr · {req.origin.replace(/^https?:\/\//, '')}</span>
        <h1 className='text-title text-fg-high lowercase'>
          {isSign ? 'approve transaction' : 'connect wallet'}
        </h1>
      </header>

      <div className='flex-1 overflow-y-auto p-4'>
        <div className='flex items-center gap-2 rounded-lg bg-canvas p-3'>
          {!!req.favIconUrl && <img src={req.favIconUrl} alt='' className='size-8 rounded-full' />}
          <div className='flex flex-col overflow-hidden'>
            {req.title && <span className='truncate text-sm'>{req.title}</span>}
            <span className='truncate text-xs text-fg-muted'>{req.origin}</span>
          </div>
        </div>

        <div className='mt-3 rounded-lg border border-border-soft p-3 text-sm'>
          {isSign ? (
            <>
              <p className='text-fg'>
                {req.origin.replace(/^https?:\/\//, '')} wants you to sign a{' '}
                {req.method === 'signDirect' ? 'transaction (direct)' : 'transaction (amino)'} on{' '}
                <span className='font-mono'>{req.chainId}</span>.
              </p>
              {req.signerAddress && (
                <p className='mt-1 break-all font-mono text-label text-fg-muted'>
                  {req.signerAddress}
                </p>
              )}
              <pre className='mt-2 max-h-48 overflow-auto rounded bg-elev-1 p-2 text-label text-fg-muted'>
                {JSON.stringify(
                  req.signDoc,
                  (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
                  1,
                )}
              </pre>
            </>
          ) : (
            <p className='text-fg'>
              connect your cosmos address on{' '}
              <span className='font-mono'>{chainIds.join(', ')}</span> to this site. it will be able
              to see your address and request signatures (each signature is approved here).
            </p>
          )}
        </div>
      </div>

      <div className='flex gap-2 border-t border-border-soft p-4'>
        <button
          type='button'
          onClick={deny}
          disabled={busy}
          className='flex-1 rounded-lg bg-elev-2 px-3 py-2.5 text-sm text-fg-muted transition-colors hover:bg-elev-1 disabled:opacity-50'
        >
          reject
        </button>
        <button
          type='button'
          onClick={() => void approve()}
          disabled={busy || !keyInfo}
          className='flex-1 rounded-lg bg-zigner-gold px-3 py-2.5 text-sm font-medium text-zigner-gold-foreground transition-colors disabled:opacity-50'
        >
          {busy ? 'working…' : isSign ? 'approve' : 'connect'}
        </button>
      </div>
    </div>
  );
};
