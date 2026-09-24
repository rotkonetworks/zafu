/**
 * receive screen - show QR code for current address
 *
 * for penumbra: supports IBC deposit from zafu's own cosmos wallets
 * - select source chain (Noble, Osmosis, etc.)
 * - shows zafu's address + balances on that chain
 * - pick asset + amount, shield into penumbra via IBC
 */

import { getTransparentHistoryInWorker } from '../../../state/keyring/network-worker';
import { useState, useCallback, useEffect, useRef } from 'react';
import { ToggleSwitch } from '../../../components/toggle-switch';
import { InjectivePanel } from './injective-panel';
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
import { type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import QRCode from 'qrcode';


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
  const [ephemeral, setEphemeral] = useState(false);
  const [ephemeralAddress, setEphemeralAddress] = useState('');
  const [ephemeralLoading, setEphemeralLoading] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
        /* probe is best-effort — never block showing the address */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transparent, transparentAddress, zidecarUrl]);

  // Load the current zcash transparent index (do NOT rotate). This used to bump
  // BOTH indices on every mount, silently burning a fresh address each time the
  // user merely opened the Receive screen. Rotation is explicit - the address
  // carets below advance the index on demand. Shielded loads separately above.
  useEffect(() => {
    if (!isZcash || !canTransparent) {
      return;
    }
    void chrome.storage.local.get('zcashTransparentIndex').then(r => {
      setTransparentIndex(r['zcashTransparentIndex'] ?? 0);
    });
  }, [isZcash, canTransparent]);

  const displayAddress =
    transparent && isZcash && transparentAddress
      ? transparentAddress
      : ephemeral && ephemeralAddress
        ? ephemeralAddress
        : address;
  const isLoading =
    transparent && isZcash ? transparentLoading : ephemeral ? ephemeralLoading : loading;

  useEffect(() => {
    if (canvasRef.current && displayAddress) {
      QRCode.toCanvas(canvasRef.current, displayAddress, {
        width: 192,
        margin: 2,
        color: { dark: '#000', light: '#fff' },
      });
    }
  }, [displayAddress]);

  useEffect(() => {
    if (!ephemeral || !isPenumbra) {
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
  }, [ephemeral, penumbraAccount]);

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
              'this wallet key does not include a transparent key — re-import from an updated zigner to enable transparent addresses',
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
  }, [displayAddress]);

  const handleToggle = useCallback(() => {
    setEphemeral(prev => {
      if (prev) {
        setEphemeralAddress('');
      }
      return !prev;
    });
    setCopied(false);
  }, []);

  const handleTransparentToggle = useCallback(() => {
    setTransparent(prev => {
      if (prev) {
        setTransparentAddress('');
      }
      return !prev;
    });
    setCopied(false);
  }, []);

  // manually rotate shielded address — bump index in storage
  const handleRotateShielded = useCallback(async () => {
    const r = await chrome.storage.local.get('zcashShieldedIndex');
    const next = (r['zcashShieldedIndex'] ?? 0) + 1;
    await chrome.storage.local.set({ zcashShieldedIndex: next });
  }, []);

  // shielded badge logic: zcash 'u'-prefixed unified addresses and
  // penumbra default addresses are shielded by construction. Transparent
  // zcash (t1/t3) and ephemeral penumbra addresses get different labels.
  const isShielded =
    (isZcash && !transparent && displayAddress?.startsWith('u')) || (isPenumbra && !ephemeral);

  return (
    <div className='flex flex-col items-center gap-4'>
      <div className='rounded-md border border-border-soft bg-white p-2'>
        {isLoading ? (
          // Skeleton matches the QR's 192×192 footprint (canvas size).
          // Pulses gently while the address derives.
          <div className='h-48 w-48 animate-pulse bg-elev-2/40' />
        ) : displayAddress ? (
          <canvas ref={canvasRef} className='h-48 w-48' />
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
            title='shielded — senders cannot see your other transactions'
          >
            <span className='i-ph-shield-check h-2.5 w-2.5' />
            shielded
          </span>
        )}
        {isZcash && transparent && (
          <span
            className='inline-flex items-center gap-1 rounded-sm border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-label text-red-400 lowercase tracking-[0.05em]'
            title='transparent — balance and history publicly visible'
          >
            <span className='i-ph-eye h-2.5 w-2.5' />
            public
          </span>
        )}
      </div>

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

      {/* advanced: address rotation + ephemeral live behind one disclosure */}
      {(isPenumbra || isZcash) && (
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
              {isPenumbra && (
                <div className='flex w-full items-center justify-between'>
                  <div className='flex items-center gap-2'>
                    <span className='text-sm font-medium'>ephemeral address</span>
                    <div className='relative'>
                      <button
                        onClick={() => setShowTooltip(prev => !prev)}
                        className='text-fg-muted transition-colors hover:text-fg-high'
                      >
                        <span className='i-ph-info h-3.5 w-3.5' />
                      </button>
                      {showTooltip && (
                        <div className='absolute left-1/2 top-6 z-50 w-72 -translate-x-1/2 rounded-lg border border-border-soft bg-canvas p-3 text-xs text-fg-muted shadow-lg lowercase'>
                          randomized single-use address, unlinkable to your main address or to each
                          other. only your viewing key detects incoming funds.
                        </div>
                      )}
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={ephemeral}
                    onChange={() => handleToggle()}
                    label='ephemeral address'
                  />
                </div>
              )}

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
          {ephemeral && isPenumbra ? (
            'ephemeral address'
          ) : transparent && isZcash ? (
            <span className='flex items-center gap-1.5'>
              transparent address #{transparentIndex}{' '}
              {transparentUsed && (
                <span className='mt-1 flex items-start gap-1.5 text-label text-hanko'>
                  <span className='i-ph-warning mt-0.5 size-3 shrink-0' />
                  this address was used before — reusing it publicly links your payments. rotate to
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
          className={`flex items-center gap-2 rounded-lg border p-3 ${
            ephemeral && isPenumbra
              ? 'border-green-500/40 bg-green-500/5'
              : transparent && isZcash
                ? 'border-rust/35 bg-rust/8'
                : 'border-border-soft bg-elev-2'
          }`}
        >
          <code
            className={`flex-1 break-all text-xs ${
              ephemeral && isPenumbra ? 'text-green-400' : transparent && isZcash ? 'text-rust' : ''
            }`}
          >
            {isLoading ? 'generating...' : displayAddress || 'no wallet selected'}
          </code>
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

      <p className='text-center text-xs text-fg-muted leading-snug lowercase'>
        {ephemeral && isPenumbra
          ? 'fresh single-use address - share with one party; reuse lets senders link payments.'
          : transparent && isZcash
            ? 'public on-chain - one index per exchange, then shield to ironwood.'
            : transparent
              ? 'transparent chain - this address is PUBLIC, not shielded. use a fresh deposit address per sender and shield into Penumbra soon after.'
              : 'shielded - senders cannot see your other transactions.'}
      </p>
    </div>
  );
}

type ReceiveMode = 'receive' | 'shield';

export function ReceivePage() {
  const activeNetwork = useStore(selectActiveNetwork);

  const { address, loading } = useActiveAddress();
  const isPenumbra = activeNetwork === 'penumbra';
  // the burner "shield" button navigates here asking for the ibc-shield tab,
  // and passes which burner (chain + index) to shield from
  const location = useLocation();
  const navState = location.state as
    | { mode?: ReceiveMode; cosmosChain?: CosmosChainId; cosmosAccountIndex?: number }
    | undefined;
  const initialMode: ReceiveMode = navState?.mode === 'shield' ? 'shield' : 'receive';
  const [mode, setMode] = useState<ReceiveMode>(initialMode);
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
        {/* tabs - Penumbra only. Two tabs: the plain shielded-address
              receive, and a combined "shield USDC" view that holds the Noble
              receive address plus the IBC-shield form. Noble is being retired
              (see the deprecation notice inside NobleReceivePanel); the
              Injective USDC ramp will replace it once eth_secp256k1 support
              lands. */}
        {isPenumbra && (
          <div className='mb-4 flex rounded-lg bg-elev-2 p-1'>
            {(['receive', 'shield'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
                  mode === m ? 'bg-canvas text-fg shadow-sm' : 'text-fg-muted hover:text-fg-high'
                }`}
              >
                {m === 'shield' ? 'shield USDC' : m}
              </button>
            ))}
          </div>
        )}

        {/* content */}
        {!isPenumbra || mode === 'receive' ? (
          <ReceiveTab address={address} loading={loading} activeNetwork={activeNetwork} />
        ) : (
          <div className='flex flex-col gap-6 overflow-y-auto'>
            {/* Injective USDC (USDC.inj) is the ONLY shielding ramp now. Noble is
                being retired (Circle winds USDC down on Noble), so shielding IN
                from Noble is removed - Noble remains available as a withdraw /
                off-ramp destination in Send only. */}
            <InjectivePanel />
          </div>
        )}
      </div>
    </div>
  );
}

export default ReceivePage;
