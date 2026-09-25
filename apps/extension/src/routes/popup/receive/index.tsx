/**
 * receive screen - show QR code for current address
 *
 * for penumbra: a "shield USDC" tab holds the Injective USDC (USDC.inj) ramp -
 * the only shielding-in path now (Noble shield-in was retired as Circle winds
 * USDC down on Noble; Noble stays a withdraw-only destination in Send). The
 * plain receive tab shows the shielded address; for penumbra that is always a
 * rotating ephemeral address (the static index address is never exposed).
 */

import { getTransparentHistoryInWorker } from '../../../state/keyring/network-worker';
import { useState, useCallback, useEffect } from 'react';
import { useBackNav } from '../../../utils/navigate';
import { useLocation } from 'react-router-dom';
import { PopupPath } from '../paths';
import { useStore } from '../../../state';
import {
  selectActiveNetwork,
  selectEffectiveKeyInfo,
  selectPenumbraAccount,
  keyRingSelector,
} from '../../../state/keyring';
import { getActiveWalletJson, selectActiveZcashWallet } from '../../../state/wallets';
import { useActiveAddress } from '../../../hooks/use-address';
import {
  derivePenumbraEphemeralFromMnemonic,
  derivePenumbraEphemeralFromFvk,
  deriveZcashTransparent,
  deriveZcashTransparentFromUfvk,
} from '../../../hooks/use-address';
import { QrCode } from '../../../components/qr-code';
import { buildZip321, parseZecAmount } from '@repo/wallet/networks/zcash/zip321';
import { TransparentReceive } from './transparent-receive';
import {
  PrivacySwitch,
  orderTransparentChains,
  type Privacy,
} from '../../../components/privacy-switch';
import { getActiveIbcSubnetworks } from '../../../config/networks';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

/** receive tab - QR code + address display */
function ReceiveTab({
  address,
  loading,
  activeNetwork,
}: {
  address: string;
  loading: boolean;
  activeNetwork: string;
}) {
  const [copied, setCopied] = useState(false);
  // Penumbra receive is ephemeral-ONLY: a fresh randomized single-use address
  // that rotates on every copy. The static index address is deliberately not
  // offered - ephemeral addresses never expire (the FVK detects funds sent to
  // any of them forever), so a static address buys nothing for receiving and
  // only invites reuse, which links payments off-chain. Anyone who genuinely
  // needs the deterministic index address can derive it with an external tool.
  const [ephemeralAddress, setEphemeralAddress] = useState('');
  const [ephemeralLoading, setEphemeralLoading] = useState(false);
  // Bumped on each copy to rotate to a fresh ephemeral address for the next share.
  const [ephemeralNonce, setEphemeralNonce] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const keyRing = useStore(keyRingSelector);
  const penumbraWallet = useStore(getActiveWalletJson);

  const zcashWallet = useStore(selectActiveZcashWallet);
  const isPenumbra = activeNetwork === 'penumbra';
  const isZcash = activeNetwork === 'zcash';
  const isMnemonic = selectedKeyInfo?.type === 'mnemonic';
  const isMultisig = selectedKeyInfo?.type === 'frost-multisig';
  const zcashUfvk =
    zcashWallet?.ufvk ??
    (zcashWallet?.orchardFvk?.startsWith('uview') ? zcashWallet.orchardFvk : undefined);
  // multisig UFVKs are orchard-only, no transparent component to derive.
  const canTransparent = (isMnemonic || !!zcashUfvk) && !isMultisig;

  // zcash shielded diversifier index (synced with chrome.storage)
  const [shieldedIndex, setShieldedIndex] = useState(0);
  useEffect(() => {
    if (!isZcash) {
      return;
    }
    chrome.storage.local.get('zcashShieldedIndex').then(r => {
      setShieldedIndex(r['zcashShieldedIndex'] ?? 0);
    });
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes['zcashShieldedIndex']?.newValue !== undefined) {
        setShieldedIndex(changes['zcashShieldedIndex'].newValue);
      }
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, [isZcash]);

  // zcash transparent address state
  const [transparent, setTransparent] = useState(false);
  const [transparentIndex, setTransparentIndex] = useState(0);
  const [transparentAddress, setTransparentAddress] = useState('');
  const [transparentLoading, setTransparentLoading] = useState(false);
  const [transparentError, setTransparentError] = useState<string | null>(null);
  // reuse guard: a transparent address that already has on-chain history
  // publicly links any new payment to the old ones. Probed per address.
  const [transparentUsed, setTransparentUsed] = useState(false);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  useEffect(() => {
    setTransparentUsed(false);
    if (!transparent || !transparentAddress) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const hist = await getTransparentHistoryInWorker('zcash', zidecarUrl, [transparentAddress]);
        if (!cancelled && hist.length > 0) {
          setTransparentUsed(true);
        }
      } catch {
        /* probe is best-effort - never block showing the address */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transparent, transparentAddress, zidecarUrl]);

  // Burner rotation for zcash transparent addresses. A transparent address is
  // public and, in this wallet's design, a recoverable burner - reusing one lets
  // senders link your payments, exactly like reusing a cosmos ramp address. So
  // when the user opens the transparent view we scan forward from the last-known
  // index for the first UNUSED address (no on-chain history) and default to it,
  // so the address presented for receiving is always fresh. The carets below
  // still let the user browse earlier (used) addresses; this only sets the
  // default. Best-effort: any failure leaves the stored index in place. Bounded
  // by a gap so a heavily-used wallet cannot scan unboundedly.
  useEffect(() => {
    if (!transparent || !isZcash || !canTransparent) {
      return;
    }
    let cancelled = false;
    const SCAN_GAP = 20;
    void (async () => {
      try {
        const mnemonic =
          isMnemonic && selectedKeyInfo ? await keyRing.getMnemonic(selectedKeyInfo.id) : undefined;
        const deriveAt = (i: number): Promise<string> | undefined =>
          mnemonic
            ? deriveZcashTransparent(mnemonic, 0, i, true)
            : zcashUfvk
              ? deriveZcashTransparentFromUfvk(zcashUfvk, i)
              : undefined;
        const stored = (await chrome.storage.local.get('zcashTransparentIndex'))[
          'zcashTransparentIndex'
        ] as number | undefined;
        const start = typeof stored === 'number' && stored > 0 ? stored : 0;
        for (let i = start; i <= start + SCAN_GAP; i++) {
          if (cancelled) {
            return;
          }
          const addr = await deriveAt(i);
          if (!addr) {
            return;
          }
          const hist = await getTransparentHistoryInWorker('zcash', zidecarUrl, [addr]).catch(
            () => [],
          );
          if (cancelled) {
            return;
          }
          if (hist.length === 0) {
            setTransparentIndex(i);
            void chrome.storage.local.set({ zcashTransparentIndex: i });
            return;
          }
        }
      } catch {
        // best-effort: on any failure keep whatever index is set
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    transparent,
    isZcash,
    canTransparent,
    isMnemonic,
    selectedKeyInfo,
    keyRing,
    zcashUfvk,
    zidecarUrl,
  ]);

  // Penumbra shows ONLY the derived ephemeral address - never the static
  // `address`. While it derives, `displayAddress` is empty and `isLoading`
  // drives the skeleton; we never fall back to the static address, so a stable
  // reusable string is never presented for penumbra.
  const displayAddress =
    transparent && isZcash && transparentAddress
      ? transparentAddress
      : isPenumbra
        ? ephemeralAddress
        : address;
  const isLoading =
    transparent && isZcash ? transparentLoading : isPenumbra ? ephemeralLoading : loading;
  const showingEphemeral = isPenumbra && !!ephemeralAddress;

  useEffect(() => {
    if (!isPenumbra) {
      return;
    }

    let cancelled = false;
    setEphemeralLoading(true);

    const generate = async () => {
      try {
        let addr: string;
        if (selectedKeyInfo?.type === 'mnemonic') {
          const mnemonic = await keyRing.getMnemonic(selectedKeyInfo.id);
          addr = await derivePenumbraEphemeralFromMnemonic(mnemonic, penumbraAccount);
        } else if (penumbraWallet?.fullViewingKey) {
          addr = await derivePenumbraEphemeralFromFvk(
            penumbraWallet.fullViewingKey,
            penumbraAccount,
          );
        } else {
          // No key material to derive from (a penumbra wallet whose JSON has no
          // FVK yet, or one still hydrating). Clear loading; the view shows the
          // empty/"no address" state rather than ever exposing the static one.
          if (!cancelled) {
            setEphemeralLoading(false);
          }
          return;
        }
        if (!cancelled) {
          setEphemeralAddress(addr);
          setEphemeralLoading(false);
        }
      } catch (err) {
        console.error('failed to generate ephemeral address:', err);
        if (!cancelled) {
          setEphemeralLoading(false);
        }
      }
    };

    void generate();
    return () => {
      cancelled = true;
    };
    // selectedKeyInfo id/type and the FVK are read inside; a late-hydrating
    // wallet must re-trigger derivation or the ephemeral view would stay empty
    // forever. ephemeralNonce re-derives to rotate after each copy.
  }, [
    isPenumbra,
    penumbraAccount,
    ephemeralNonce,
    selectedKeyInfo?.id,
    selectedKeyInfo?.type,
    penumbraWallet?.fullViewingKey,
  ]);

  // derive zcash transparent address when toggled on or index changes
  useEffect(() => {
    if (!transparent || !isZcash || !canTransparent) {
      return;
    }

    let cancelled = false;
    setTransparentLoading(true);
    setTransparentError(null);

    const derive = async () => {
      try {
        if (isMnemonic && selectedKeyInfo) {
          // mnemonic wallet: derive from seed (supports multiple indices)
          const mnemonic = await keyRing.getMnemonic(selectedKeyInfo.id);
          const addr = await deriveZcashTransparent(mnemonic, 0, transparentIndex, true);
          if (!cancelled) {
            setTransparentAddress(addr);
            setTransparentLoading(false);
          }
        } else if (zcashUfvk) {
          // watch-only wallet: derive from UFVK at selected index
          console.log('[receive] deriving transparent from ufvk, index:', transparentIndex);
          const addr = await deriveZcashTransparentFromUfvk(zcashUfvk, transparentIndex);
          console.log('[receive] transparent address:', addr);
          if (!cancelled) {
            setTransparentAddress(addr);
            setTransparentLoading(false);
          }
        }
      } catch (err) {
        console.error('failed to derive transparent address:', err);
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('no transparent component')) {
            setTransparentError(
              'this wallet key does not include a transparent key - re-import from an updated zigner to enable transparent addresses',
            );
          } else {
            setTransparentError(msg);
          }
          setTransparentAddress('');
          setTransparentLoading(false);
        }
      }
    };

    void derive();
    return () => {
      cancelled = true;
    };
  }, [transparent, transparentIndex, isZcash, canTransparent, isMnemonic, zcashUfvk]);

  const copyAddress = useCallback(async () => {
    if (!displayAddress) {
      return;
    }
    await navigator.clipboard.writeText(displayAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    // Rotate: after copying an ephemeral penumbra address, advance to a fresh one
    // so the next share is a new, unlinkable address (burner semantics). The just
    // -copied one stays valid forever - the wallet's FVK detects every ephemeral.
    if (showingEphemeral) {
      setEphemeralNonce(n => n + 1);
    }
  }, [displayAddress, showingEphemeral]);

  const handleTransparentToggle = useCallback(() => {
    setTransparent(prev => {
      if (prev) {
        setTransparentAddress('');
      }
      return !prev;
    });
    setCopied(false);
  }, []);

  // manually rotate shielded address - bump index in storage
  const handleRotateShielded = useCallback(async () => {
    const r = await chrome.storage.local.get('zcashShieldedIndex');
    const next = (r['zcashShieldedIndex'] ?? 0) + 1;
    await chrome.storage.local.set({ zcashShieldedIndex: next });
  }, []);

  // shielded badge logic: zcash 'u'-prefixed unified addresses and ALL penumbra
  // addresses are shielded by construction - an ephemeral penumbra address is
  // just as shielded as the static one (notes hide the recipient either way), so
  // it keeps the badge. Only transparent zcash (t1/t3) is public and drops it.
  const isShielded = (isZcash && !transparent && displayAddress?.startsWith('u')) || isPenumbra;

  // ZIP 321: ask for an amount (and a memo, when shielded) in the QR itself
  const paymentRequests = useStore(s => s.privacy.settings.enablePaymentRequests);
  const [showRequest, setShowRequest] = useState(false);
  const [requestAmount, setRequestAmount] = useState('');
  const [requestMemo, setRequestMemo] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  const requestZat = parseZecAmount(requestAmount.trim());
  const amountInvalid = requestAmount.trim() !== '' && requestZat === undefined;
  const requestUri =
    isZcash && paymentRequests && showRequest && displayAddress && (requestZat || requestMemo)
      ? buildZip321({
          address: displayAddress,
          amountZat: requestZat,
          memo: isShielded ? requestMemo.trim() || undefined : undefined,
        })
      : undefined;
  const qrValue = requestUri ?? displayAddress;

  return (
    <div className='flex flex-col items-center gap-4'>
      <div className='border border-border-soft'>
        {isLoading ? (
          // Skeleton matches the QR's 192x192 footprint; pulses while the
          // address derives.
          <div className='h-48 w-48 animate-pulse bg-elev-2/40' />
        ) : displayAddress ? (
          <QrCode
            value={qrValue ?? displayAddress}
            size={192}
            label={requestUri ? 'payment request QR' : 'address QR'}
          />
        ) : (
          <div className='flex h-48 w-48 items-center justify-center'>
            <span className='text-label text-fg-dim lowercase'>no wallet</span>
          </div>
        )}
      </div>

      <div className='flex items-center gap-1.5'>
        <span className='rounded-sm border border-network-accent/30 bg-network-accent/10 px-2.5 py-0.5 text-label text-network-accent lowercase tracking-[0.08em]'>
          {activeNetwork}
        </span>
        {isShielded && (
          <span
            className='inline-flex items-center gap-1 rounded-sm border border-zigner-gold/30 bg-zigner-gold/10 px-2 py-0.5 text-label text-zigner-gold lowercase tracking-[0.05em]'
            title='shielded - senders cannot see your other transactions'
          >
            <span className='i-ph-shield-check h-2.5 w-2.5' />
            shielded
          </span>
        )}
        {isZcash && transparent && (
          <span
            className='inline-flex items-center gap-1 rounded-sm border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-label text-red-400 lowercase tracking-[0.05em]'
            title='transparent - balance and history publicly visible'
          >
            <span className='i-ph-eye h-2.5 w-2.5' />
            public
          </span>
        )}
      </div>

      {isZcash && paymentRequests && displayAddress && (
        <div className='flex w-full flex-col gap-1.5'>
          {!showRequest ? (
            <button
              type='button'
              onClick={() => setShowRequest(true)}
              className='self-center text-xs text-fg-muted hover:text-fg-high lowercase'
            >
              request an amount
            </button>
          ) : (
            <>
              <div className='flex gap-1.5'>
                <input
                  type='text'
                  inputMode='decimal'
                  value={requestAmount}
                  onChange={e => setRequestAmount(e.target.value)}
                  placeholder='ZEC amount'
                  aria-label='requested amount'
                  className='min-w-0 flex-1 border border-border-soft bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none'
                />
                <button
                  type='button'
                  onClick={() => {
                    setShowRequest(false);
                    setRequestAmount('');
                    setRequestMemo('');
                  }}
                  className='shrink-0 px-2 text-xs text-fg-muted hover:text-fg-high'
                  aria-label='remove request'
                >
                  <span className='i-ph-x h-3.5 w-3.5' />
                </button>
              </div>
              {isShielded && (
                <input
                  type='text'
                  value={requestMemo}
                  onChange={e => setRequestMemo(e.target.value)}
                  maxLength={512}
                  placeholder='memo (optional)'
                  aria-label='requested memo'
                  className='border border-border-soft bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none'
                />
              )}
              {amountInvalid && <p className='text-xs text-red-400'>up to 8 decimals</p>}
              {requestUri && (
                <button
                  type='button'
                  onClick={() => {
                    void navigator.clipboard.writeText(requestUri);
                    setLinkCopied(true);
                    setTimeout(() => setLinkCopied(false), 1500);
                  }}
                  className='self-center text-xs text-zigner-gold hover:underline'
                >
                  {linkCopied ? 'copied' : 'copy payment link'}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* zcash: shielded is the default; transparent is a secondary tab */}
      {isZcash && canTransparent && (
        <div className='flex w-full rounded-lg bg-elev-2 p-1'>
          <button
            onClick={() => transparent && handleTransparentToggle()}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
              !transparent ? 'bg-canvas text-fg shadow-sm' : 'text-fg-muted hover:text-fg-high'
            }`}
          >
            shielded
          </button>
          <button
            onClick={() => !transparent && handleTransparentToggle()}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
              transparent ? 'bg-canvas text-fg shadow-sm' : 'text-fg-muted hover:text-fg-high'
            }`}
          >
            transparent
          </button>
        </div>
      )}

      {isZcash && transparent && transparentError && (
        <p className='w-full text-xs text-red-400'>{transparentError}</p>
      )}

      {/* advanced: zcash address-index rotation lives behind one disclosure.
          Penumbra has nothing here - it is ephemeral-only, so there is no
          static/index option to expose. */}
      {isZcash && (
        <div className='w-full'>
          <button
            onClick={() => setShowAdvanced(prev => !prev)}
            className='flex w-full items-center justify-between py-1 text-xs text-fg-muted transition-colors hover:text-fg-high lowercase'
          >
            <span>advanced</span>
            <span
              className={`i-ph-caret-down h-4 w-4 transition-transform ${
                showAdvanced ? 'rotate-180' : ''
              }`}
            />
          </button>

          {showAdvanced && (
            <div className='mt-2 flex flex-col gap-3 rounded-lg border border-border-soft bg-elev-1 p-3'>
              {isZcash && !transparent && (
                <div className='flex w-full items-center justify-center gap-2'>
                  <button
                    disabled={shieldedIndex <= 0}
                    onClick={() => {
                      const prev = Math.max(0, shieldedIndex - 1);
                      void chrome.storage.local.set({ zcashShieldedIndex: prev });
                    }}
                    className='p-1 text-fg-muted transition-colors hover:text-fg-high disabled:opacity-50'
                  >
                    <span className='i-ph-caret-left h-4 w-4' />
                  </button>
                  <span className='min-w-[110px] text-center text-xs font-medium text-fg-muted'>
                    address #{shieldedIndex}
                  </span>
                  <button
                    onClick={() => void handleRotateShielded()}
                    className='p-1 text-fg-muted transition-colors hover:text-fg-high'
                  >
                    <span className='i-ph-caret-right h-4 w-4' />
                  </button>
                </div>
              )}

              {isZcash && transparent && canTransparent && !transparentError && (
                <div className='flex w-full items-center justify-center gap-2'>
                  <button
                    disabled={transparentIndex <= 0}
                    onClick={() => setTransparentIndex(i => i - 1)}
                    className='p-1 text-fg-muted transition-colors hover:text-fg-high disabled:opacity-50'
                  >
                    <span className='i-ph-caret-left h-4 w-4' />
                  </button>
                  <span className='min-w-[110px] text-center text-xs font-medium text-fg-muted'>
                    address #{transparentIndex}
                  </span>
                  <button
                    onClick={() => {
                      setTransparentIndex(i => {
                        const next = i + 1;
                        // persist highest-seen index
                        chrome.storage.local.get('zcashTransparentIndex').then(r => {
                          if (next > (r['zcashTransparentIndex'] ?? 0)) {
                            void chrome.storage.local.set({ zcashTransparentIndex: next });
                          }
                        });
                        return next;
                      });
                    }}
                    className='p-1 text-fg-muted transition-colors hover:text-fg-high'
                  >
                    <span className='i-ph-caret-right h-4 w-4' />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className='w-full'>
        <div className='mb-1 text-xs text-fg-muted'>
          {showingEphemeral ? (
            'ephemeral address'
          ) : transparent && isZcash ? (
            <span className='flex items-center gap-1.5'>
              transparent address #{transparentIndex}{' '}
              {transparentUsed && (
                <span className='mt-1 flex items-start gap-1.5 text-label text-hanko'>
                  <span className='i-ph-warning mt-0.5 size-3 shrink-0' />
                  this address was used before - reusing it publicly links your payments. rotate to
                  a fresh address.
                </span>
              )}
              <span className='text-label px-1.5 py-0.5 rounded-md bg-rust/15 text-rust font-medium leading-none'>
                public
              </span>
            </span>
          ) : isZcash ? (
            `shielded address #${shieldedIndex}`
          ) : (
            'address'
          )}
        </div>
        <div
          className={`flex items-center gap-2 border p-3 ${
            showingEphemeral
              ? 'border-zigner-gold/40 bg-zigner-gold/5'
              : transparent && isZcash
                ? 'border-rust/35 bg-rust/8'
                : 'border-border-soft bg-elev-2'
          }`}
        >
          <code
            className={`flex-1 break-all text-xs ${
              showingEphemeral ? 'text-zigner-gold' : transparent && isZcash ? 'text-rust' : ''
            }`}
          >
            {isLoading ? 'generating...' : displayAddress || 'no wallet selected'}
          </code>
          {showingEphemeral && (
            <button
              onClick={() => {
                setCopied(false);
                setEphemeralNonce(n => n + 1);
              }}
              className='flex shrink-0 items-center text-fg-muted transition-colors hover:text-fg-high'
              title='rotate to a fresh address'
              aria-label='rotate to a fresh ephemeral address'
            >
              <span className='i-ph-arrows-clockwise h-4 w-4' />
            </button>
          )}
          {displayAddress && (
            <button
              onClick={copyAddress}
              className='flex shrink-0 items-center gap-1 text-fg-muted transition-colors hover:text-fg-high'
              title={copied ? 'copied to clipboard' : 'copy address'}
            >
              {copied ? (
                <>
                  <span className='i-ph-check h-4 w-4' />
                  <span className='text-label lowercase'>copied</span>
                </>
              ) : (
                <span className='i-ph-copy h-4 w-4' />
              )}
            </button>
          )}
        </div>
      </div>

      {/* the rotate button already says "fresh address"; no caption needed */}
      {!showingEphemeral && (
        <p className='text-center text-xs text-fg-muted leading-snug lowercase'>
          {transparent && isZcash
            ? 'public on-chain - one index per exchange, then shield to ironwood.'
            : transparent
              ? 'transparent chain - this address is PUBLIC, not shielded. use a fresh deposit address per sender and shield into Penumbra soon after.'
              : null}
        </p>
      )}
    </div>
  );
}

export function ReceivePage() {
  const activeNetwork = useStore(selectActiveNetwork);

  const { address, loading } = useActiveAddress();
  const isPenumbra = activeNetwork === 'penumbra';
  // Transparent chains you can receive on from here: launched, with a route
  // into Penumbra, and not being wound down (Noble is withdraw-only now).
  const transparentChains = isPenumbra
    ? orderTransparentChains(
        (getActiveIbcSubnetworks('penumbra') as CosmosChainId[]).filter(
          c => COSMOS_CHAINS[c].penumbraChannel && !COSMOS_CHAINS[c].deprecation,
        ),
      )
    : [];
  // Old deep links (`?mode=shield`, nav state mode 'shield') meant the
  // Injective deposit view; `receiveChain` picks a chain directly.
  const location = useLocation();
  const navState = location.state as { mode?: string; receiveChain?: CosmosChainId } | null;
  const legacyShield =
    new URLSearchParams(location.search).get('mode') === 'shield' || navState?.mode === 'shield';
  const requested = navState?.receiveChain ?? (legacyShield ? 'injective' : undefined);
  const initial = requested && transparentChains.includes(requested) ? requested : undefined;
  const [privacy, setPrivacy] = useState<Privacy>(initial ? 'transparent' : 'shielded');
  const [pickedChain, setPickedChain] = useState<CosmosChainId | undefined>(initial);
  const receiveOn: 'penumbra' | CosmosChainId =
    privacy === 'transparent' ? (pickedChain ?? transparentChains[0] ?? 'penumbra') : 'penumbra';
  const goBack = useBackNav(PopupPath.INDEX);

  return (
    <div className='flex h-full flex-col'>
      <div className='flex shrink-0 items-center gap-3 border-b border-border-soft px-4 py-3'>
        <button onClick={goBack} className='text-fg-muted transition-colors hover:text-fg-high'>
          <span className='i-ph-arrow-left h-5 w-5' />
        </button>
        <h1 className='text-lg font-medium text-fg'>receive</h1>
      </div>

      <div className='flex flex-1 flex-col p-4'>
        {transparentChains.length > 0 && (
          <PrivacySwitch
            privacy={privacy}
            onPrivacy={setPrivacy}
            chains={transparentChains}
            chain={receiveOn === 'penumbra' ? undefined : receiveOn}
            onChain={setPickedChain}
          />
        )}
        {receiveOn === 'penumbra' ? (
          <ReceiveTab address={address} loading={loading} activeNetwork={activeNetwork} />
        ) : (
          <TransparentReceive key={receiveOn} chainId={receiveOn} />
        )}
      </div>
    </div>
  );
}

export default ReceivePage;
