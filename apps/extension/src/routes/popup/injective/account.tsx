/**
 * Injective USDC ramp panel - the receive-and-shield conduit UI.
 *
 * Injective is a receive+shield conduit only (not a full wallet): the user
 * withdraws Circle-native USDC (USDC.inj) from an exchange to their in-wallet
 * inj address, then either shields it into Penumbra over IBC, or sends it back
 * out to an exchange. Injective is Ethermint (eth_secp256k1 / coin type 60), so
 * every derive+sign here goes through packages/wallet/src/networks/injective -
 * NEVER the shared cosmos secp256k1 path (which would derive the wrong address).
 *
 * This whole panel is gated behind isLaunched('injective') by the caller and
 * stays hidden until the #34 funded-testnet round-trip passes; the signer it
 * calls is unit-tested but unproven on a live node until then.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { QrCode } from '../../../components/qr-code';
import { Button } from '@repo/ui/components/ui/button';
import { useStore } from '../../../state';
import {
  selectEffectiveKeyInfo,
  selectPenumbraAccount,
  keyRingSelector,
} from '../../../state/keyring';
import { derivePenumbraEphemeralFromMnemonic } from '../../../hooks/use-address';
import { usePasswordGate } from '../../../hooks/password-gate';
import { COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import { parseAmountToBaseUnits } from '@repo/wallet/networks/cosmos/signer';
import {
  deriveInjectiveAddress,
  parseInjectiveRecipient,
  type InjectiveRecipientProblem,
} from '@repo/wallet/networks/injective/derive';
import { queryInjectiveBalances, queryInjectiveTx } from '@repo/wallet/networks/injective/client';
import { shieldInToPenumbra, withdrawToExchange } from '@repo/wallet/networks/injective/conduit';
import {
  holdsSponsorStable,
  requestInjectiveFeeGrant,
} from '@repo/wallet/networks/injective/feegrant';
import { trackTx } from '../../../tx-ops';
import { acceptedInjectiveAssets, heldAcceptedAssets, totalHeld, type HeldAsset } from './assets';
import { nextHdIndex, peekHdIndex } from '@repo/storage-chrome/cosmos-chain-counters';
import {
  injectiveScanIndices,
  mergeFundedIndices,
  resolveSelectedInjectiveIndex,
  shortInjAddress,
  type InjectiveIndexBalance,
} from './addresses';

const CFG = COSMOS_CHAINS.injective;

/**
 * Gas sponsor (apps/feegrant). When the user holds USDC.inj but not enough INJ,
 * the shield-in is sent with fee.granter = the sponsor and costs them no INJ.
 * The sponsor is only contacted in that case; if it is not deployed or is down,
 * the probe fails and the panel behaves exactly as before (INJ required).
 * Withdraw-to-exchange is a MsgSend, which the allowance does not cover.
 */
const GAS_SPONSOR_URL = 'https://sponsor.zafu.pro';

/** how many shown receive indices to remember per vault */
const MAX_SHOWN_REMEMBERED = 1000;
/** cadence of the slow sweep over shown addresses outside the hot scan set */
const COLD_SWEEP_MS = 180_000;

/** One short line per way a pasted recipient can be wrong. */
const RECIPIENT_PROBLEM: Record<InjectiveRecipientProblem, (prefix?: string) => string> = {
  penumbra: () => 'penumbra address - use shield instead',
  'other-chain': prefix => `${prefix ?? 'other'} address, not injective`,
  checksum: () => 'typo - a character is wrong',
  format: () => 'not an address',
};
const GAS_ASSET = CFG.gasAsset ?? { symbol: 'INJ', denom: 'inj', decimals: 18 };

/**
 * transaction explorer for a broadcast hash on injective-1. injscan.com is the
 * current Injective explorer; the old explorer.injective.network host 301s here,
 * so we link it directly to avoid a cross-host redirect.
 */
const EXPLORER_TX = (hash: string) => `https://injscan.com/transaction/${hash}`;

/** gas is a fixed limit; the whole fee is paid in INJ (18-dec), NOT USDC. */
const GAS_LIMIT = '400000';

/** the INJ (gas-asset) fee for one conduit tx, in INJ base units. */
function gasFeeInjBaseUnits(): bigint {
  const perGas = BigInt(/^\d+/.exec(CFG.gasPrice)?.[0] ?? '160000000');
  return perGas * BigInt(GAS_LIMIT);
}

function injectiveFee() {
  return {
    amount: [{ denom: GAS_ASSET.denom, amount: gasFeeInjBaseUnits().toString() }],
    gas: GAS_LIMIT,
  };
}

/**
 * Base units -> human string for DISPLAY (no float math). Trims trailing zeros
 * and caps the shown fraction at maxFrac; used for balances and the gas fee.
 */
function formatBaseUnits(amount: bigint, decimals: number, maxFrac = decimals): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = (amount % divisor)
    .toString()
    .padStart(decimals, '0')
    .slice(0, maxFrac)
    .replace(/0+$/, '');
  const shown = frac ? `${whole}.${frac}` : `${whole}`;
  // a real balance too small to show must not read as zero
  return amount > 0n && shown === '0' ? `<0.${'0'.repeat(Math.max(0, maxFrac - 1))}1` : shown;
}

/**
 * Base units -> a full-precision decimal string for the Max button. The value it
 * fills must round-trip back through parseAmountToBaseUnits to the exact same
 * base units, so it keeps all `decimals` (only trailing zeros trimmed).
 */
function fullDecimalString(amount: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = (amount % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Convert a human amount to integer base units of an asset with `decimals`,
 * WITHOUT float math (Math.round(n * 1e6) loses precision and Number() accepts
 * scientific notation / trailing junk). Reject anything that is not a plain
 * decimal, and treat zero as invalid.
 */
function toBaseUnits(human: string, decimals: number): string | undefined {
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const base = parseAmountToBaseUnits(trimmed, decimals);
  return base === '0' ? undefined : base;
}

/**
 * Honest status flow for a conduit tx:
 *   idle -> signing (query+sign+broadcast) -> submitted (in mempool, code 0)
 *        -> done (included on-chain) | error
 * A BROADCAST_MODE_SYNC code 0 only means "accepted", so `submitted` polls the
 * LCD for block inclusion before it promotes to `done`.
 */
type TxStatus = 'idle' | 'signing' | 'submitted' | 'done' | 'error';
interface TxState {
  status: TxStatus;
  hash?: string;
  error?: string;
}

const isBusy = (s: TxStatus) => s === 'signing' || s === 'submitted';

/**
 * Once a tx is `submitted`, poll the LCD for on-chain inclusion and promote it
 * to `done` (or `error` if it landed with a non-zero code). Caps polling so a
 * packet that never lands is left honestly at `submitted`. StrictMode-safe: the
 * cleanup cancels in-flight work and clears the interval.
 */
function useInjectiveInclusion(tx: TxState, setTx: (t: TxState) => void, onSettled: () => void) {
  const { status, hash } = tx;
  useEffect(() => {
    if (status !== 'submitted' || !hash) {
      return;
    }
    let cancelled = false;
    const started = Date.now();
    const tick = async (): Promise<boolean> => {
      try {
        const st = await queryInjectiveTx(CFG.restEndpoint, hash);
        if (cancelled) {
          return true;
        }
        if (st.found) {
          if (st.code === 0) {
            setTx({ status: 'done', hash });
          } else {
            setTx({ status: 'error', hash, error: st.rawLog || `tx failed (code ${st.code})` });
          }
          onSettled();
          return true;
        }
      } catch {
        // transient LCD/network error - keep polling until the cap
      }
      return false;
    };
    const timer = setInterval(() => {
      void tick().then(settled => {
        if (cancelled) {
          return;
        }
        if (settled) {
          clearInterval(timer);
        } else if (Date.now() - started > 90_000) {
          // give up polling but don't strand the UI in a busy state: surface it
          // as an error the user can follow on the explorer (the tx may still
          // land - inclusion just outran our window).
          clearInterval(timer);
          setTx({
            status: 'error',
            hash,
            error: 'not confirmed within 90s - check the explorer; it may still land',
          });
        }
      });
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status, hash, setTx, onSettled]);
}

/**
 * A reference to a broadcast tx. Opening a block explorer hands it the user's
 * IP next to this txid, which links them to the transaction - so the link only
 * appears when they opted in (settings > privacy > explorer links, off by
 * default). Otherwise the hash is copyable, to look up privately (e.g. over Tor).
 */
const TxRef = ({ hash }: { hash: string }) => {
  const explorerEnabled = useStore(s => s.privacy.settings.enableExplorerLinks);
  const [copied, setCopied] = useState(false);
  if (explorerEnabled) {
    return (
      <a
        href={EXPLORER_TX(hash)}
        target='_blank'
        rel='noreferrer noopener'
        className='text-zigner-gold hover:underline'
        title='opens injscan.com - it sees your ip and this tx'
      >
        view tx
      </a>
    );
  }
  return (
    <button
      type='button'
      onClick={() => {
        void navigator.clipboard.writeText(hash);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className='text-zigner-gold hover:underline'
      title={hash}
    >
      {copied ? 'copied tx id' : 'copy tx id'}
    </button>
  );
};

export const InjectiveAccount = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const { getMnemonic } = useStore(keyRingSelector);
  const { requestAuth, PasswordModal } = usePasswordGate();
  const queryClient = useQueryClient();

  const [injAddress, setInjAddress] = useState('');
  const [copied, setCopied] = useState(false);
  const [shieldAmount, setShieldAmount] = useState('');
  const [withdrawAddr, setWithdrawAddr] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [shieldTx, setShieldTx] = useState<TxState>({ status: 'idle' });
  const [withdrawTx, setWithdrawTx] = useState<TxState>({ status: 'idle' });
  // Withdraw-to-exchange is the secondary flow; keep it collapsed so the default
  // view is just receive + shield and not a wall of two forms.
  const [showWithdraw, setShowWithdraw] = useState(false);

  const isMnemonic = selectedKeyInfo?.type === 'mnemonic';

  // derive the inj receive address (account 0). Pure key derivation - no
  // broadcast - so it is safe to run on mount when the wallet is unlocked.
  useEffect(() => {
    let cancelled = false;
    if (!isMnemonic || !selectedKeyInfo) {
      setInjAddress('');
      return;
    }
    void (async () => {
      try {
        const mnemonic = await getMnemonic(selectedKeyInfo.id);
        if (!mnemonic) {
          return;
        }
        const addr = await deriveInjectiveAddress(mnemonic, 0);
        if (cancelled) {
          return;
        }
        setInjAddress(addr);
      } catch (err) {
        console.error('[injective] failed to derive address:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isMnemonic, selectedKeyInfo, getMnemonic]);

  // Receive like a bitcoin HD wallet: every open takes the next unused index,
  // and the rotate button takes another. An address is never shown twice, even
  // one that already holds funds - those stay in the addresses list below, where
  // they are still scanned and can be shielded from. Shares the counter with
  // dapp burners (zafu_get_fresh_chain_address), so indices never collide.
  const [receiveNonce, setReceiveNonce] = useState(0);
  const [receive, setReceive] = useState<{ index: number; address: string }>();
  useEffect(() => {
    let cancelled = false;
    const keyId = isMnemonic ? selectedKeyInfo?.id : undefined;
    if (!keyId) {
      setReceive(undefined);
      return;
    }
    void (async () => {
      try {
        // key first: allocating while locked would burn an index nobody sees
        const mnemonic = await getMnemonic(keyId);
        if (!mnemonic || cancelled) {
          return;
        }
        const index = await nextHdIndex('injective');
        const address = await deriveInjectiveAddress(mnemonic, index);
        if (cancelled) {
          return;
        }
        setReceive({ index, address });
        void rememberShown(keyId, index);
        void queryClient.invalidateQueries({ queryKey: ['injective-hd-peek'] });
      } catch (err) {
        console.error('[injective] failed to allocate a receive address:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isMnemonic, selectedKeyInfo?.id, getMnemonic, receiveNonce, queryClient]);

  // Every index ever shown as a receive address, per vault (numbers only - no
  // addresses on disk). An exchange often keeps paying a whitelisted address
  // long after we rotated past it; those are swept too (see coldQuery), so
  // funds sent to any address we ever showed always become visible.
  const shownKeyFor = (keyId: string) => `injectiveShownIndices:${keyId}`;
  const [shownIndices, setShownIndices] = useState<number[]>([]);
  const rememberShown = useCallback(async (keyId: string, index: number) => {
    const key = shownKeyFor(keyId);
    const prev = ((await chrome.storage.local.get(key))[key] as number[] | undefined) ?? [];
    if (prev.includes(index)) {
      return;
    }
    const next = [...prev, index].slice(-MAX_SHOWN_REMEMBERED);
    await chrome.storage.local.set({ [key]: next });
    setShownIndices(next);
  }, []);
  useEffect(() => {
    const keyId = selectedKeyInfo?.id;
    if (!keyId) {
      setShownIndices([]);
      return;
    }
    const key = shownKeyFor(keyId);
    void (async () => {
      const stored = (await chrome.storage.local.get(key))[key] as number[] | undefined;
      if (stored) {
        setShownIndices(stored);
        return;
      }
      // First run with this list: every index handed out so far (receive
      // addresses and dapp burners share the counter) was potentially shown.
      const highest = await peekHdIndex('injective');
      const seeded = Array.from({ length: highest }, (_, i) => i + 1).slice(-MAX_SHOWN_REMEMBERED);
      await chrome.storage.local.set({ [key]: seeded });
      setShownIndices(seeded);
    })().catch(() => undefined);
  }, [selectedKeyInfo?.id]);

  // Indices that have ever held funds, per vault, so an old receive address
  // that rotated out of the recent scan window keeps being watched.
  const fundedKey = selectedKeyInfo?.id ? `injectiveFundedIndices:${selectedKeyInfo.id}` : '';
  const [fundedIndices, setFundedIndices] = useState<number[]>([]);
  useEffect(() => {
    if (!fundedKey) {
      setFundedIndices([]);
      return;
    }
    void chrome.storage.local
      .get(fundedKey)
      .then(r => setFundedIndices((r[fundedKey] as number[] | undefined) ?? []))
      .catch(() => undefined);
  }, [fundedKey]);

  // Burner discovery: dapps get fresh inj1 burners from zafu_get_fresh_chain_address,
  // which allocates via nextHdIndex('injective'). peekHdIndex reads that counter
  // (the highest index handed out) WITHOUT incrementing it. Same cadence as the
  // balance poll so a burner issued while the popup is open shows up.
  const hdPeekQuery = useQuery({
    queryKey: ['injective-hd-peek'],
    enabled: isMnemonic,
    staleTime: 10_000,
    refetchInterval: 15_000,
    queryFn: () => peekHdIndex('injective'),
  });
  const scanKey = injectiveScanIndices(hdPeekQuery.data ?? 0, undefined, fundedIndices)
    .filter(i => i > 0)
    .join(',');

  // Derive burner addresses (index > 0). Each derivation runs a sync bip39 seed
  // stretch, so results are cached per vault+index and only new indices are
  // derived when the counter grows. Coin type 60 via deriveInjectiveAddress only.
  const burnerCache = useRef<{ keyId?: string; map: Map<number, string> }>({ map: new Map() });
  const [burnerAddrs, setBurnerAddrs] = useState<{ index: number; address: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    const keyId = isMnemonic ? selectedKeyInfo?.id : undefined;
    if (!keyId) {
      burnerCache.current = { map: new Map() };
      setBurnerAddrs([]);
      return;
    }
    if (burnerCache.current.keyId !== keyId) {
      burnerCache.current = { keyId, map: new Map() };
      setBurnerAddrs([]);
    }
    const cache = burnerCache.current.map;
    const wanted = scanKey ? scanKey.split(',').map(Number) : [];
    void (async () => {
      try {
        const missing = wanted.filter(i => !cache.has(i));
        if (missing.length) {
          const mnemonic = await getMnemonic(keyId);
          if (!mnemonic) {
            return;
          }
          for (const i of missing) {
            if (cancelled) {
              return;
            }
            cache.set(i, await deriveInjectiveAddress(mnemonic, i));
            // yield between derivations so the popup stays responsive
            await new Promise<void>(resolve => setTimeout(resolve, 0));
          }
        }
        if (!cancelled) {
          setBurnerAddrs(wanted.map(index => ({ index, address: cache.get(index)! })));
        }
      } catch (err) {
        console.error('[injective] failed to derive burner addresses:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isMnemonic, selectedKeyInfo?.id, scanKey, getMnemonic]);

  const scanTargets = useMemo(
    () => (injAddress ? [{ index: 0, address: injAddress }, ...burnerAddrs] : []),
    [injAddress, burnerAddrs],
  );

  // live balances on account 0 + every scanned burner: USDC.inj (ramp asset) +
  // INJ (gas). Read-only LCD bank queries, refreshed periodically so funds
  // arriving from an exchange (or an unshield to a burner) show up. Account 0
  // failing fails the query (shown as an error); a burner failing only drops
  // that burner for this tick.
  const balancesQuery = useQuery({
    queryKey: ['injective-balances', scanTargets.map(t => `${t.index}:${t.address}`).join(',')],
    enabled: scanTargets.length > 0,
    staleTime: 10_000,
    refetchInterval: 15_000,
    queryFn: async (): Promise<InjectiveIndexBalance[]> => {
      const settled = await Promise.allSettled(
        scanTargets.map(t => queryInjectiveBalances(CFG.restEndpoint, t.address, CFG.denom)),
      );
      const rows: InjectiveIndexBalance[] = [];
      settled.forEach((r, i) => {
        const t = scanTargets[i]!;
        if (r.status === 'fulfilled') {
          rows.push({
            index: t.index,
            address: t.address,
            usdc: r.value.usdc,
            inj: r.value.inj,
            all: r.value.all,
          });
        } else if (t.index === 0) {
          throw r.reason;
        }
      });
      return rows;
    },
  });
  const rows = useMemo(() => balancesQuery.data ?? [], [balancesQuery.data]);
  useEffect(() => {
    if (!fundedKey || !rows.length) {
      return;
    }
    const merged = mergeFundedIndices(fundedIndices, rows);
    if (merged.length !== fundedIndices.length) {
      setFundedIndices(merged);
      void chrome.storage.local.set({ [fundedKey]: merged }).catch(() => undefined);
    }
  }, [rows, fundedKey, fundedIndices]);
  // Slow sweep of every shown address outside the hot scan set. Anything
  // holding funds is promoted to the funded set, which the 15s poll watches.
  const hotKey = scanKey;
  const coldIndices = useMemo(() => {
    const hot = new Set([0, ...(hotKey ? hotKey.split(',').map(Number) : [])]);
    return shownIndices.filter(i => !hot.has(i));
  }, [hotKey, shownIndices]);
  const coldQuery = useQuery({
    queryKey: ['injective-cold-sweep', selectedKeyInfo?.id, coldIndices.join(',')],
    enabled: isMnemonic && coldIndices.length > 0,
    staleTime: COLD_SWEEP_MS - 10_000,
    refetchInterval: COLD_SWEEP_MS,
    queryFn: async (): Promise<number[]> => {
      const keyId = selectedKeyInfo?.id;
      const mnemonic = keyId ? await getMnemonic(keyId) : undefined;
      if (!mnemonic) {
        return [];
      }
      const cache = burnerCache.current.map;
      const found: number[] = [];
      for (const i of coldIndices) {
        let address = cache.get(i);
        if (!address) {
          address = await deriveInjectiveAddress(mnemonic, i);
          cache.set(i, address);
        }
        try {
          const b = await queryInjectiveBalances(CFG.restEndpoint, address, CFG.denom);
          if (b.inj > 0n || b.usdc > 0n || (b.all ?? []).some(x => x.amount > 0n)) {
            found.push(i);
          }
        } catch {
          // endpoint hiccup: the next sweep retries this index
        }
        // one at a time, yielding: this is a background chore
        await new Promise<void>(resolve => setTimeout(resolve, 50));
      }
      return found;
    },
  });
  useEffect(() => {
    const found = coldQuery.data;
    if (!fundedKey || !found?.length) {
      return;
    }
    const merged = [...new Set([...fundedIndices, ...found])].sort((a, b) => a - b);
    if (merged.length !== fundedIndices.length) {
      setFundedIndices(merged);
      void chrome.storage.local.set({ [fundedKey]: merged }).catch(() => undefined);
    }
  }, [coldQuery.data, fundedKey, fundedIndices]);

  const totals = useMemo(
    () =>
      totalHeld(
        rows.map(r => r.all ?? []),
        acceptedInjectiveAssets(CFG.penumbraSourceChannel ?? 'channel-18'),
        CFG.denom,
      ),
    [rows],
  );
  const [showAddresses, setShowAddresses] = useState(false);

  // The ONE index the shield / withdraw forms act on. Every balance check, the
  // sponsor decision, the fee-grant grantee, and the signer's accountIndex all
  // derive from `selected`, so they can never disagree about which account.
  // an address picked elsewhere (home's deposit rows) arrives as nav state
  const navIndex = (useLocation().state as { injectiveIndex?: number } | null)?.injectiveIndex;
  const [userPick, setUserPick] = useState<number | undefined>(navIndex);
  const resolvedIndex = resolveSelectedInjectiveIndex(rows, userPick);
  // Freeze the address while the user is mid-action. The resolved default can
  // move on its own (another address becomes the largest, a burner empties, a
  // poll of the chosen burner fails); an amount typed while looking at one
  // address must never be shielded or withdrawn from another. Only an explicit
  // pick moves a pinned selection.
  const midAction =
    shieldAmount !== '' ||
    withdrawAmount !== '' ||
    isBusy(shieldTx.status) ||
    isBusy(withdrawTx.status);
  const [pinnedIndex, setPinnedIndex] = useState<number>();
  useEffect(() => {
    if (midAction && pinnedIndex === undefined) {
      setPinnedIndex(resolvedIndex);
    } else if (!midAction && pinnedIndex !== undefined) {
      setPinnedIndex(undefined);
    }
  }, [midAction, pinnedIndex, resolvedIndex]);
  const selectedIndex = pinnedIndex ?? resolvedIndex;
  const selected = rows.find(r => r.index === selectedIndex);
  const selectedAddress = selected?.address ?? (selectedIndex === 0 ? injAddress : '');

  // Any accepted Injective asset on the selected address, USDC.inj by default.
  // Both forms act on this one asset.
  const accepted = acceptedInjectiveAssets(CFG.penumbraSourceChannel ?? 'channel-18');
  const held = heldAcceptedAssets(selected?.all ?? [], accepted, CFG.denom);
  const [assetDenom, setAssetDenom] = useState<string>(CFG.denom);
  const usdcMeta = accepted.get(CFG.denom.toLowerCase()) ?? {
    denom: CFG.denom,
    symbol: CFG.symbol,
    decimals: CFG.decimals,
  };
  // what can actually move: INJ only when it covers more than the fee
  const movable = held.filter(a =>
    a.denom.toLowerCase() === GAS_ASSET.denom ? a.amount > gasFeeInjBaseUnits() : true,
  );
  const asset: HeldAsset = movable.find(a => a.denom === assetDenom) ??
    movable[0] ?? { ...usdcMeta, amount: 0n };
  const isInj = asset.denom.toLowerCase() === GAS_ASSET.denom;
  // If the asset the forms act on changes for ANY reason (picking another
  // address that doesn't hold it, the balance emptying), a typed amount must
  // not carry over: "20" meant 20 USDC.inj, never 20 INJ.
  const lastAssetRef = useRef(asset.denom);
  useEffect(() => {
    if (lastAssetRef.current !== asset.denom) {
      lastAssetRef.current = asset.denom;
      setShieldAmount('');
      setWithdrawAmount('');
    }
  }, [asset.denom]);
  const injBal = selected?.inj ?? 0n;
  const balancesReady = selected !== undefined;

  // `refetch` is bound once by the QueryObserver and is identity-stable, unlike
  // `balancesQuery` (a fresh tracked object every render). Depending on the
  // latter would restart the inclusion poller on every render and defeat its cap.
  const { refetch: refetchQuery, isFetching } = balancesQuery;
  const refetchBalances = useCallback(() => {
    void refetchQuery();
  }, [refetchQuery]);

  useInjectiveInclusion(shieldTx, setShieldTx, refetchBalances);
  useInjectiveInclusion(withdrawTx, setWithdrawTx, refetchBalances);

  const feeInj = gasFeeInjBaseUnits();
  const feeDisplay = `${formatBaseUnits(feeInj, GAS_ASSET.decimals, 6)} ${GAS_ASSET.symbol}`;
  // don't block on a not-yet-loaded balance (defaults to 0n): only gate once we
  // actually know the INJ balance can't cover gas.
  const gasOk = !balancesReady || injBal >= feeInj;

  // Only probe the sponsor when it would actually be used: USDC to shield and
  // too little INJ to pay for it. No request (and no IP to the sponsor) otherwise.
  // one unit of any accepted stablecoin qualifies (same rule as the sponsor)
  const wantsSponsor = balancesReady && injBal < feeInj && holdsSponsorStable(selected?.all ?? []);
  const sponsorQuery = useQuery({
    queryKey: ['injective-gas-sponsor'],
    enabled: wantsSponsor,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`${GAS_SPONSOR_URL}/v1/injective/granter`);
      if (!res.ok) {
        throw new Error(`gas sponsor unavailable (${res.status})`);
      }
      return (await res.json()) as { granter?: string };
    },
  });
  const canSponsor = wantsSponsor && !!sponsorQuery.data?.granter;
  // The shield leg may be sponsored; the withdraw leg (MsgSend) never is.
  const shieldGasOk = gasOk || canSponsor;

  // moving INJ itself must leave the fee behind
  const spendable = isInj ? (asset.amount > feeInj ? asset.amount - feeInj : 0n) : asset.amount;
  const shieldBase = toBaseUnits(shieldAmount, asset.decimals);
  const shieldExceeds = balancesReady && !!shieldBase && BigInt(shieldBase) > spendable;
  const withdrawBase = toBaseUnits(withdrawAmount, asset.decimals);
  const withdrawExceeds = balancesReady && !!withdrawBase && BigInt(withdrawBase) > spendable;
  const recipient = parseInjectiveRecipient(withdrawAddr);
  const withdrawAddrOk = recipient.ok;
  const withdrawTo = recipient.ok ? recipient.address : '';
  // one send at a time: when both legs act on the same index an overlapping
  // shield + withdraw would collide on the sequence number.
  const anyBusy = isBusy(shieldTx.status) || isBusy(withdrawTx.status);

  /** "20 USDC.inj +1" for an address row */
  const rowSummary = (r: InjectiveIndexBalance): string => {
    const list = heldAcceptedAssets(r.all ?? [], accepted, CFG.denom);
    const first = list[0];
    if (!first) {
      return '0';
    }
    const more = list.length > 1 ? ` +${list.length - 1}` : '';
    return `${formatBaseUnits(first.amount, first.decimals, 2)} ${first.symbol}${more}`;
  };
  /** the asset picker both forms share; nothing when there is one asset */
  const assetPicker =
    movable.length > 1 ? (
      <select
        value={asset.denom}
        onChange={e => {
          setAssetDenom(e.target.value);
          setShieldAmount('');
          setWithdrawAmount('');
        }}
        disabled={anyBusy}
        aria-label='asset'
        className='mb-2 w-full border border-border-soft bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none'
      >
        {movable.map(a => (
          <option key={a.denom} value={a.denom}>
            {a.symbol} - {formatBaseUnits(a.amount, a.decimals, 4)}
          </option>
        ))}
      </select>
    ) : null;

  const copy = useCallback(() => {
    if (!receive) {
      return;
    }
    void navigator.clipboard.writeText(receive.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [receive]);

  const handleShield = useCallback(async () => {
    const base = toBaseUnits(shieldAmount, asset.decimals);
    if (!base || !selectedKeyInfo || !CFG.penumbraChannel || !selectedAddress) {
      return;
    }
    const penumbraChannel = CFG.penumbraChannel;
    if (!(await requestAuth())) {
      return;
    }
    setShieldTx({ status: 'signing' });
    try {
      const res = await trackTx(
        { network: 'injective', label: `shield ${shieldAmount} ${asset.symbol}` },
        async step => {
          const mnemonic = await getMnemonic(selectedKeyInfo.id);
          if (!mnemonic) {
            throw new Error('wallet locked');
          }
          // the conduit re-derives from accountIndex; make sure that is the address
          // every check (and the fee grant) above was made against.
          if ((await deriveInjectiveAddress(mnemonic, selectedIndex)) !== selectedAddress) {
            throw new Error('address/index mismatch - refresh and retry');
          }
          // fresh single-use Penumbra IBC deposit address for this shield-in
          const penumbraReceiver = await derivePenumbraEphemeralFromMnemonic(
            mnemonic,
            penumbraAccount,
          );
          const sourceChannel = penumbraChannel; // channel-494 (injective -> penumbra)
          // No INJ for gas: get a fee allowance first. Resolves once it is on-chain.
          step(canSponsor ? 'getting gas' : 'signing');
          const feeGranter = canSponsor
            ? (await requestInjectiveFeeGrant(GAS_SPONSOR_URL, selectedAddress)).granter
            : undefined;
          const send = () =>
            shieldInToPenumbra({
              mnemonic,
              accountIndex: selectedIndex,
              restUrl: CFG.restEndpoint,
              sourceChannel,
              penumbraReceiver,
              token: { denom: asset.denom, amount: base },
              // 10-minute IBC timeout, in nanoseconds
              timeoutTimestamp: BigInt(Date.now() + 10 * 60 * 1000) * 1_000_000n,
              fee: injectiveFee(),
              feeGranter,
            });
          step('broadcasting');
          let res = await send();
          if (feeGranter && res.code !== 0 && /fee-grant not found/i.test(res.rawLog)) {
            // The grant is in a block the sponsor's node has seen but this node may
            // not have yet. A CheckTx rejection consumes no sequence, so resend once.
            await new Promise<void>(resolve => {
              setTimeout(resolve, 3000);
            });
            res = await send();
          }
          if (res.code !== 0) {
            throw new Error(res.rawLog || `broadcast failed (code ${res.code})`);
          }
          return { ...res, txId: res.txhash, restUrl: CFG.restEndpoint };
        },
      );
      setShieldTx({ status: 'submitted', hash: res.txhash });
      setShieldAmount('');
      refetchBalances();
    } catch (err) {
      setShieldTx({ status: 'error', error: err instanceof Error ? err.message : 'shield failed' });
    }
  }, [
    asset,
    shieldAmount,
    selectedKeyInfo,
    requestAuth,
    getMnemonic,
    penumbraAccount,
    refetchBalances,
    canSponsor,
    selectedIndex,
    selectedAddress,
  ]);

  const handleWithdraw = useCallback(async () => {
    const base = toBaseUnits(withdrawAmount, asset.decimals);
    if (!base || !withdrawTo || !selectedKeyInfo || !selectedAddress) {
      return;
    }
    if (!(await requestAuth())) {
      return;
    }
    setWithdrawTx({ status: 'signing' });
    try {
      const res = await trackTx(
        { network: 'injective', label: `withdraw ${withdrawAmount} ${asset.symbol}` },
        async step => {
          const mnemonic = await getMnemonic(selectedKeyInfo.id);
          if (!mnemonic) {
            throw new Error('wallet locked');
          }
          if ((await deriveInjectiveAddress(mnemonic, selectedIndex)) !== selectedAddress) {
            throw new Error('address/index mismatch - refresh and retry');
          }
          // No INJ for gas: a send-capable grant from the sponsor first.
          const sponsored = canSponsor && !gasOk;
          step(sponsored ? 'getting gas' : 'signing');
          const feeGranter = sponsored
            ? (await requestInjectiveFeeGrant(GAS_SPONSOR_URL, selectedAddress, fetch, 'send'))
                .granter
            : undefined;
          const send = () =>
            withdrawToExchange({
              mnemonic,
              accountIndex: selectedIndex,
              restUrl: CFG.restEndpoint,
              toAddress: withdrawTo,
              amount: { denom: asset.denom, amount: base },
              fee: injectiveFee(),
              feeGranter,
            });
          step('broadcasting');
          let res = await send();
          if (feeGranter && res.code !== 0 && /fee-grant not found/i.test(res.rawLog)) {
            // the grant is in a block this node may not have seen yet; a CheckTx
            // rejection consumes no sequence, so resend once
            await new Promise<void>(resolve => {
              setTimeout(resolve, 3000);
            });
            res = await send();
          }
          if (res.code !== 0) {
            throw new Error(res.rawLog || `broadcast failed (code ${res.code})`);
          }
          return { ...res, txId: res.txhash, restUrl: CFG.restEndpoint };
        },
      );
      setWithdrawTx({ status: 'submitted', hash: res.txhash });
      setWithdrawAmount('');
      refetchBalances();
    } catch (err) {
      setWithdrawTx({
        status: 'error',
        error: err instanceof Error ? err.message : 'withdraw failed',
      });
    }
  }, [
    asset,
    canSponsor,
    gasOk,
    withdrawAmount,
    withdrawTo,
    selectedKeyInfo,
    requestAuth,
    getMnemonic,
    refetchBalances,
    selectedIndex,
    selectedAddress,
  ]);

  if (!isMnemonic) {
    return (
      <div className='rounded-md border border-border-soft bg-elev-1 p-4 text-sm text-fg-muted lowercase'>
        cold wallets can't derive an Injective address in-app yet.
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      {/* receive */}
      <div className='rounded-lg border border-border-soft p-4'>
        <div className='mb-2 flex items-center justify-between text-xs font-medium lowercase'>
          <span>your Injective address</span>
          {receive && <span className='font-mono text-label text-fg-muted'>#{receive.index}</span>}
        </div>
        {receive && (
          <QrCode
            value={receive.address}
            size={176}
            label='Injective address QR'
            className='mb-3'
          />
        )}
        <div className='mb-3 flex items-center gap-2'>
          <span className='truncate font-mono text-xs' title={receive?.address}>
            {receive?.address ?? 'deriving...'}
          </span>
          <button
            type='button'
            onClick={() => setReceiveNonce(n => n + 1)}
            className='flex shrink-0 items-center text-fg-muted hover:text-fg-high'
            title='new address'
            aria-label='new address'
          >
            <span className='i-ph-arrows-clockwise h-4 w-4' />
          </button>
          <button
            type='button'
            onClick={copy}
            className='shrink-0 text-label text-fg-muted hover:text-fg-high'
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </div>

        {/* balances across every address */}
        <div className='rounded-md border border-border-soft bg-elev-1 p-3'>
          <div className='flex items-center justify-between'>
            <button
              type='button'
              onClick={() => setShowAddresses(v => !v)}
              className='flex items-center gap-1 text-label text-fg-muted lowercase hover:text-fg-high'
            >
              <span
                className={`h-3 w-3 ${showAddresses ? 'i-ph-caret-down' : 'i-ph-caret-right'}`}
              />
              addresses ({rows.length})
            </button>
            <button
              type='button'
              onClick={refetchBalances}
              disabled={!injAddress || isFetching}
              className='flex items-center gap-1 text-label text-fg-muted hover:text-fg-high disabled:opacity-50'
              title='refresh balance'
              aria-label='refresh balance'
            >
              <span className={`i-lucide-refresh-cw h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {balancesQuery.isError ? (
            <p className='mt-1 text-label text-red-400 lowercase'>couldn't load balance</p>
          ) : (
            <div className='mt-1 flex flex-col gap-0.5'>
              {totals.length === 0 ? (
                <span className='font-mono text-lg text-fg-muted'>0</span>
              ) : (
                totals.map((t, i) => (
                  <span
                    key={t.denom}
                    className={`font-mono ${i === 0 ? 'text-lg' : 'text-xs text-fg-muted'}`}
                  >
                    {formatBaseUnits(t.amount, t.decimals, i === 0 ? 4 : 6)}{' '}
                    <span className='text-xs text-fg-muted'>{t.symbol}</span>
                  </span>
                ))
              )}
            </div>
          )}
          {/* every scanned address; funded ones can be picked for shield / withdraw */}
          {showAddresses && (
            <div className='mt-2 border-t border-border-soft pt-2'>
              {rows.map(r => {
                const funded = r.usdc > 0n || r.inj > 0n;
                const active = r.index === selectedIndex;
                return (
                  <button
                    key={r.index}
                    type='button'
                    onClick={() => {
                      setUserPick(r.index);
                      // an explicit pick is the one thing allowed to move a pin
                      if (pinnedIndex !== undefined) {
                        setPinnedIndex(r.index);
                      }
                    }}
                    disabled={anyBusy || !funded}
                    title={r.address}
                    className={`flex w-full items-center gap-2 px-1.5 py-1 text-left font-mono text-label disabled:cursor-default ${
                      active
                        ? 'bg-elev-2 text-fg-high'
                        : funded
                          ? 'text-fg-muted hover:bg-elev-2'
                          : 'text-fg-dim'
                    }`}
                  >
                    <span
                      className={`h-3 w-3 shrink-0 ${
                        active
                          ? 'i-ph-radio-button-fill text-zigner-gold'
                          : funded
                            ? 'i-ph-circle'
                            : ''
                      }`}
                    />
                    <span className='w-8 shrink-0'>#{r.index}</span>
                    <span className='truncate'>{shortInjAddress(r.address)}</span>
                    <span className='ml-auto shrink-0'>{rowSummary(r)}</span>
                  </button>
                );
              })}
            </div>
          )}
          {!gasOk &&
            !canSponsor &&
            movable.some(a => a.denom.toLowerCase() !== GAS_ASSET.denom) && (
              <p className='mt-2 text-label text-amber-400/90 lowercase'>no INJ for gas</p>
            )}
        </div>
      </div>

      {/* forms only when something can move; otherwise say so, once */}
      {balancesReady && movable.length === 0 && !anyBusy ? (
        <div className='border border-border-soft p-4 text-xs text-fg-muted lowercase'>
          nothing to move yet
        </div>
      ) : (
        <>
          {/* shield in */}
          <div className='rounded-lg border border-border-soft p-4'>
            <div className='mb-2 flex items-baseline justify-between text-xs font-medium lowercase'>
              <span>shield into Penumbra</span>
              {selectedIndex !== 0 && (
                <span className='font-mono text-label text-fg-muted' title={selectedAddress}>
                  from {shortInjAddress(selectedAddress)}
                </span>
              )}
            </div>
            {assetPicker}
            <div className='relative mb-2'>
              <input
                type='number'
                min='0'
                step='any'
                value={shieldAmount}
                onChange={e => setShieldAmount(e.target.value)}
                placeholder={`${asset.symbol} amount`}
                className='w-full rounded-lg border border-border-soft bg-input px-3 py-2 pr-14 text-sm focus:border-zigner-gold focus:outline-none'
              />
              <button
                type='button'
                onClick={() => setShieldAmount(fullDecimalString(spendable, asset.decimals))}
                disabled={spendable === 0n}
                className='absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-label font-medium text-zigner-gold hover:bg-elev-1 disabled:opacity-40'
              >
                max
              </button>
            </div>
            <p className='mb-2 text-label text-fg-muted lowercase'>
              {canSponsor && !gasOk
                ? 'fee covered by the rotko sponsor - no INJ needed.'
                : `fee ~${feeDisplay}, paid in INJ.`}
            </p>
            {shieldExceeds && (
              <p className='mb-2 text-label text-amber-400/90 lowercase'>
                amount is more than your {asset.symbol} balance.
              </p>
            )}
            <Button
              variant='gradient'
              className='w-full'
              disabled={!shieldBase || shieldExceeds || !shieldGasOk || anyBusy}
              onClick={() => void handleShield()}
            >
              {shieldTx.status === 'signing'
                ? canSponsor && !gasOk
                  ? 'getting gas, shielding...'
                  : 'shielding...'
                : shieldTx.status === 'submitted'
                  ? 'confirming...'
                  : `shield ${asset.symbol} to Penumbra`}
            </Button>
            {shieldTx.status === 'submitted' && (
              <p className='mt-2 text-label text-fg-muted lowercase'>
                submitted - included soon, then IBC-delivered to Penumbra.{' '}
                {shieldTx.hash && <TxRef hash={shieldTx.hash} />}
              </p>
            )}
            {shieldTx.status === 'done' && (
              <p className='mt-2 text-label text-green-400 lowercase'>
                included on Injective - IBC delivery to Penumbra is in flight.{' '}
                {shieldTx.hash && <TxRef hash={shieldTx.hash} />}
              </p>
            )}
            {shieldTx.status === 'error' && (
              <p className='mt-2 text-label text-red-400'>{shieldTx.error}</p>
            )}
          </div>

          {/* withdraw - secondary flow, collapsed by default */}
          <div className='rounded-lg border border-border-soft p-4'>
            <button
              type='button'
              onClick={() => setShowWithdraw(v => !v)}
              className='flex w-full items-center justify-between text-xs font-medium lowercase text-fg-muted transition-colors hover:text-fg-high'
            >
              <span>withdraw to an exchange</span>
              <span
                className={`i-ph-caret-down h-4 w-4 transition-transform ${showWithdraw ? 'rotate-180' : ''}`}
              />
            </button>
            {showWithdraw && (
              <div className='mt-3'>
                {selectedIndex !== 0 && (
                  <p className='mb-1 font-mono text-label text-fg-muted' title={selectedAddress}>
                    from {shortInjAddress(selectedAddress)}
                  </p>
                )}
                <input
                  type='text'
                  value={withdrawAddr}
                  onChange={e => setWithdrawAddr(e.target.value.trim())}
                  placeholder='exchange deposit address (inj1 or 0x)'
                  className='mb-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2 font-mono text-xs focus:border-zigner-gold focus:outline-none'
                />
                {withdrawAddr &&
                  (recipient.ok ? (
                    <p
                      className='mb-2 flex items-center gap-1 font-mono text-label text-fg-muted'
                      title={recipient.address}
                    >
                      <span className='i-ph-check size-3 text-zigner-gold' />
                      {recipient.fromHex ? 'sends to ' : ''}
                      {shortInjAddress(recipient.address)}
                      {recipient.address === selectedAddress && (
                        <span className='text-amber-400/90'> - this wallet</span>
                      )}
                    </p>
                  ) : (
                    <p className='mb-2 text-label text-red-400 lowercase'>
                      {RECIPIENT_PROBLEM[recipient.problem](recipient.prefix)}
                    </p>
                  ))}
                {assetPicker}
                <div className='relative mb-2'>
                  <input
                    type='number'
                    min='0'
                    step='any'
                    value={withdrawAmount}
                    onChange={e => setWithdrawAmount(e.target.value)}
                    placeholder={`${asset.symbol} amount`}
                    className='w-full rounded-lg border border-border-soft bg-input px-3 py-2 pr-14 text-sm focus:border-zigner-gold focus:outline-none'
                  />
                  <button
                    type='button'
                    onClick={() => setWithdrawAmount(fullDecimalString(spendable, asset.decimals))}
                    disabled={spendable === 0n}
                    className='absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-label font-medium text-zigner-gold hover:bg-elev-1 disabled:opacity-40'
                  >
                    max
                  </button>
                </div>
                <p className='mb-2 text-label text-fg-muted lowercase'>
                  {canSponsor && !gasOk
                    ? 'fee covered by the rotko sponsor - no INJ needed.'
                    : `fee ~${feeDisplay}, paid in INJ.`}
                </p>
                {!gasOk && !canSponsor && (
                  <p className='mb-2 text-label text-amber-400/90 lowercase'>
                    needs ~{feeDisplay} of your own INJ for gas
                  </p>
                )}
                {withdrawExceeds && (
                  <p className='mb-2 text-label text-amber-400/90 lowercase'>
                    amount is more than your {asset.symbol} balance.
                  </p>
                )}
                <Button
                  className='w-full'
                  disabled={
                    !withdrawBase ||
                    withdrawExceeds ||
                    !withdrawAddrOk ||
                    (!gasOk && !canSponsor) ||
                    anyBusy
                  }
                  onClick={() => void handleWithdraw()}
                >
                  {withdrawTx.status === 'signing'
                    ? 'sending...'
                    : withdrawTx.status === 'submitted'
                      ? 'confirming...'
                      : !gasOk && !canSponsor
                        ? 'needs INJ for gas'
                        : `withdraw ${asset.symbol}`}
                </Button>
                {withdrawTx.status === 'submitted' && (
                  <p className='mt-2 text-label text-fg-muted lowercase'>
                    submitted - waiting for inclusion.{' '}
                    {withdrawTx.hash && <TxRef hash={withdrawTx.hash} />}
                  </p>
                )}
                {withdrawTx.status === 'done' && (
                  <p className='mt-2 text-label text-green-400 lowercase'>
                    sent - included on Injective.{' '}
                    {withdrawTx.hash && <TxRef hash={withdrawTx.hash} />}
                  </p>
                )}
                {withdrawTx.status === 'error' && (
                  <p className='mt-2 text-label text-red-400'>{withdrawTx.error}</p>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {PasswordModal}
    </div>
  );
};
