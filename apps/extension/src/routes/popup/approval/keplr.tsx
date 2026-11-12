/**
 * Approval screen for the Keplr provider. It runs in a popup with keyring
 * access, so it is where the cosmos address is derived and where amino/direct
 * signing happens (via the tested cosmjs wallets). The service worker only
 * orchestrated getting us here; we post the result back and close.
 *
 * A zigner wallet connects with the cosmos key it exported, and signs amino
 * docs (signArbitrary, signAmino) through the cosmos sign QR: show the
 * request, scan zigner's answer, check it against the key and the doc.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../../../state';
import { keyRingSelector, selectEffectiveKeyInfo } from '../../../state/keyring';
import { getCosmosChain } from '@repo/wallet/networks/cosmos/chains';
import { OriginIcon } from '../../../shared/components/origin-icon';
import {
  deriveKeplrWireKey,
  signKeplrAmino,
  signKeplrDirect,
  type KeplrDirectWireDoc,
} from '@repo/wallet/networks/cosmos/signer';
import { adr036SignDoc, describeArbitraryData } from '@repo/wallet/networks/cosmos/adr036';
import {
  cosmosChainIdFromKeplr,
  keplrApprovalKey,
  type KeplrApprovalRequest,
  type KeplrWireKey,
} from '../../../message/keplr';
import { Clipped } from '@repo/ui/components/ui/clipped';
import { Button } from '@repo/ui/components/ui/button';
import { isCosmosSignatureQR, parseCosmosSignatureQR } from '@repo/wallet/networks/cosmos/airgap';
import { verifyAdr036 } from '@repo/wallet/networks/cosmos/adr036';
import {
  zignerAminoRequest,
  zignerAminoSignature,
  zignerKeplrKey,
} from '@repo/wallet/networks/cosmos/zigner-keplr';
import { QrDisplay } from '../../../shared/components/qr-display';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { CAPS, walletKind } from '../../../signing/wallet-kind';

/** prefix for a keplr chain id, from our config or a bech32 signer address */
const prefixFor = (chainId: string, signerAddress?: string): string => {
  const id = cosmosChainIdFromKeplr(chainId);
  if (id) {
    return getCosmosChain(id).bech32Prefix;
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
  /** a zigner signature in progress: the request QR, then the camera; a bad scan says why */
  const [zigner, setZigner] = useState<
    { qr: string; scanning: boolean; error?: string } | undefined
  >();
  const cold = !!keyInfo && CAPS[walletKind(keyInfo)].cosmos === 'zigner';
  const coldKeyHex = keyInfo?.insensitive['cosmosPublicKey'] as string | undefined;

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

  const respond = async (result: unknown) => {
    // await delivery before closing: window.close() tears down this popup's
    // context, and a still-in-flight sendMessage is dropped with it, leaving
    // the service worker's pending resolver (and the dapp's promise) hung.
    // The result listener acks with { ok: true }, so the await also confirms
    // the worker received it.
    try {
      await chrome.runtime.sendMessage({ type: 'zafu_keplr_result', requestId, result });
    } catch {
      // worker already gone - nothing more we can do; still close the popup
    }
    window.close();
  };

  const deny = () => void respond({ approved: false, error: 'rejected' });

  /** the amino doc a zigner signs for this request */
  const coldDoc = () => req?.signDoc as Parameters<typeof zignerAminoRequest>[2];

  const fail = (err: unknown) =>
    respond({
      approved: false,
      error: err instanceof Error ? err.message : "it wasn't signed · please try again",
    });

  const approveCold = async () => {
    if (!req || !keyInfo) {
      return;
    }
    if (req.method === 'enable') {
      const keys: Record<string, KeplrWireKey> = {};
      for (const cid of chainIds) {
        const key = zignerKeplrKey(coldKeyHex, prefixFor(cid), keyInfo.name ?? 'zigner');
        if (!key) {
          throw new Error('this wallet has no cosmos key · import it again from zigner');
        }
        keys[cid] = key;
      }
      await respond({ approved: true, payload: { keys } });
      return;
    }
    if (req.method === 'signDirect') {
      throw new Error('zigner signs amino only · this site asked for a direct signature');
    }
    const accountIndex = (keyInfo.insensitive['accountIndex'] as number | undefined) ?? 0;
    const chainName =
      cosmosChainIdFromKeplr(req.chainId) ?? prefixFor(req.chainId, req.signerAddress);
    setZigner({ qr: zignerAminoRequest(accountIndex, chainName, coldDoc()), scanning: false });
  };

  /**
   * zigner's answer: checked against the key and the doc before the site gets
   * it. A code that fails goes back to the request QR to scan again.
   */
  const onColdScan = async (hex: string) => {
    if (!req || !zigner) {
      return;
    }
    try {
      if (!isCosmosSignatureQR(hex)) {
        throw new Error("that code isn't zigner's answer · please scan again");
      }
      const signer = req.signerAddress ?? '';
      const doc = coldDoc();
      const signature = zignerAminoSignature(coldKeyHex, signer, doc, parseCosmosSignatureQR(hex));
      if (req.method === 'signArbitrary') {
        const data = Uint8Array.from(atob(String(doc.msgs[0]?.value?.data ?? '')), c =>
          c.charCodeAt(0),
        );
        if (!verifyAdr036(prefixFor(req.chainId, signer), signer, data, signature)) {
          throw new Error("that answer isn't zigner's signature for this message");
        }
        await respond({ approved: true, payload: signature });
        return;
      }
      await respond({
        approved: true,
        payload: {
          signed: doc,
          signatureB64: signature.signature,
          pubKeyB64: signature.pub_key.value,
        },
      });
    } catch (err) {
      setZigner({
        qr: zigner.qr,
        scanning: false,
        error:
          err instanceof Error ? err.message : "that answer didn't check out · please scan again",
      });
    }
  };

  const approve = async () => {
    if (!req || !keyInfo) {
      return;
    }
    setBusy(true);
    try {
      if (cold) {
        await approveCold();
        return;
      }
      const mnemonic = await getMnemonic(keyInfo.id);

      if (req.method === 'enable') {
        const keys: Record<string, KeplrWireKey> = {};
        for (const cid of chainIds) {
          keys[cid] = await deriveKeplrWireKey(mnemonic, prefixFor(cid), keyInfo.name ?? 'zafu');
        }
        await respond({ approved: true, payload: { keys } });
        return;
      }

      const prefix = prefixFor(req.chainId, req.signerAddress);

      if (req.method === 'signArbitrary') {
        const res = await signKeplrAmino(
          mnemonic,
          prefix,
          req.signerAddress ?? '',
          req.signDoc as ReturnType<typeof adr036SignDoc>,
        );
        await respond({
          approved: true,
          payload: {
            pub_key: { type: 'tendermint/PubKeySecp256k1', value: res.pubKeyB64 },
            signature: res.signatureB64,
          },
        });
        return;
      }

      if (req.method === 'signAmino') {
        const payload = await signKeplrAmino(
          mnemonic,
          prefix,
          req.signerAddress ?? '',
          req.signDoc as Parameters<typeof signKeplrAmino>[3],
        );
        await respond({ approved: true, payload });
        return;
      }

      // signDirect
      const payload = await signKeplrDirect(
        mnemonic,
        prefix,
        req.signerAddress ?? '',
        req.signDoc as KeplrDirectWireDoc,
      );
      await respond({ approved: true, payload });
    } catch (err) {
      await fail(err);
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

  if (zigner?.scanning) {
    return (
      <div className='flex h-full min-h-0 flex-col bg-canvas'>
        <QrScanner
          onScan={hex => void onColdScan(hex)}
          onClose={() => setZigner({ ...zigner, scanning: false })}
          title="scan zigner's answer"
          description="point the camera at zigner's answer"
        />
      </div>
    );
  }
  if (zigner) {
    return (
      <div className='flex h-full min-h-0 flex-col bg-canvas'>
        <header className='shrink-0 border-b border-border-soft p-4'>
          <span className='kicker'>keplr · {(req.origin ?? '').replace(/^https?:\/\//, '')}</span>
          <h1 className='mt-1 text-title text-fg-high lowercase'>sign with zigner</h1>
        </header>
        <div className='flex min-h-0 flex-1 flex-col items-center overflow-y-auto p-4'>
          <QrDisplay
            data={zigner.qr}
            size={840}
            title='scan with zigner'
            description='open zigner and scan this code to sign'
            showCopy
          />
          {zigner.error && (
            <p role='alert' className='mt-3 text-center text-sm text-red-400'>
              {zigner.error}
            </p>
          )}
        </div>
        <div className='flex shrink-0 gap-3 border-t border-border-soft p-4'>
          <Button variant='secondary' className='flex-1' onClick={deny}>
            not now
          </Button>
          <Button
            variant='primary'
            className='flex-1'
            onClick={() => setZigner({ ...zigner, scanning: true })}
          >
            scan zigner's answer
          </Button>
        </div>
      </div>
    );
  }

  const isSign = req.method !== 'enable';
  const message =
    req.method === 'signArbitrary'
      ? describeArbitraryData(
          Uint8Array.from(
            atob((req.signDoc as ReturnType<typeof adr036SignDoc>).msgs[0]?.value.data ?? ''),
            c => c.charCodeAt(0),
          ),
        )
      : undefined;
  // A stored request missing origin (partial/forward-incompatible write) would
  // otherwise throw on .replace during render.
  const originHost = (req.origin ?? '').replace(/^https?:\/\//, '');
  return (
    <div className='flex h-full flex-col'>
      <header className='flex flex-col items-center justify-center border-b border-border-soft py-4'>
        <span className='kicker mb-1'>keplr · {originHost}</span>
        <h1 className='text-title text-fg-high lowercase'>
          {message ? 'sign a message' : isSign ? 'approve transaction' : 'connect wallet'}
        </h1>
      </header>

      <div className='flex-1 overflow-y-auto p-4'>
        <div className='flex items-center gap-2 bg-canvas p-3'>
          {!!req.origin && <OriginIcon origin={req.origin} size={32} />}
          <div className='flex flex-col overflow-hidden'>
            {req.title && <Clipped className='text-sm'>{req.title}</Clipped>}
            <Clipped className='text-xs text-fg-muted' label='site'>
              {req.origin ?? ''}
            </Clipped>
          </div>
        </div>

        <div className='mt-3 border border-border-soft p-3 text-sm'>
          {message ? (
            <>
              <p className='text-fg'>
                {originHost} wants you to sign a message. it moves no funds.
              </p>
              <p className='mt-1 break-all font-mono text-label text-fg-muted'>
                {req.signerAddress}
              </p>
              <span className='kicker mt-2 block'>{message.hex ? 'message (hex)' : 'message'}</span>
              <pre className='mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all bg-elev-1 p-2 text-label text-fg'>
                {message.text}
              </pre>
            </>
          ) : isSign ? (
            <>
              <p className='text-fg'>
                {originHost} wants you to sign a{' '}
                {req.method === 'signDirect' ? 'transaction (direct)' : 'transaction (amino)'} on{' '}
                <span className='font-mono'>{req.chainId}</span>.
              </p>
              {req.signerAddress && (
                <p className='mt-1 break-all font-mono text-label text-fg-muted'>
                  {req.signerAddress}
                </p>
              )}
              <pre className='mt-2 max-h-48 overflow-auto bg-elev-1 p-2 text-label text-fg-muted'>
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
          className='flex-1 bg-elev-2 px-3 py-2.5 text-sm text-fg-muted transition-colors hover:bg-elev-1 disabled:opacity-50'
        >
          not now
        </button>
        <button
          type='button'
          onClick={() => void approve()}
          disabled={busy || !keyInfo}
          className='flex-1 bg-zigner-gold px-3 py-2.5 text-sm text-zigner-gold-foreground transition-colors disabled:opacity-50'
        >
          {busy ? 'working…' : isSign ? 'approve' : 'connect'}
        </button>
      </div>
    </div>
  );
};
