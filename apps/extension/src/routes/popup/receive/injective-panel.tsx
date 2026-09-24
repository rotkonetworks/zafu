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
import { useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
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
  isValidInjectiveAddress,
} from '@repo/wallet/networks/injective/derive';
import { queryInjectiveBalances, queryInjectiveTx } from '@repo/wallet/networks/injective/client';
import { shieldInToPenumbra, withdrawToExchange } from '@repo/wallet/networks/injective/conduit';
import { requestInjectiveFeeGrant } from '@repo/wallet/networks/injective/feegrant';
import { peekHdIndex } from '@repo/storage-chrome/cosmos-chain-counters';
import {
  fundedBurners,
  injectiveScanIndices,
  resolveSelectedInjectiveIndex,
  shortInjAddress,
  type InjectiveIndexBalance,
} from './injective-burners';

const CFG = COSMOS_CHAINS.injective;

/**
 * Gas sponsor (apps/feegrant). When the user holds USDC.inj but not enough INJ,
 * the shield-in is sent with fee.granter = the sponsor and costs them no INJ.
 * The sponsor is only contacted in that case; if it is not deployed or is down,
 * the probe fails and the panel behaves exactly as before (INJ required).
 * Withdraw-to-exchange is a MsgSend, which the allowance does not cover.
 */
const GAS_SPONSOR_URL = 'https://sponsor.zafu.pro';
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
  return frac ? `${whole}.${frac}` : `${whole}`;
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
 * USDC.inj is 6-dec; convert a human amount to integer base units WITHOUT float
 * math (Math.round(n * 1e6) loses precision and Number() accepts scientific
 * notation / trailing junk). Reuse the integer-only helper; reject anything that
 * is not a plain decimal, and treat zero as invalid.
 */
function toBaseUnits(human: string): string | undefined {
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const base = parseAmountToBaseUnits(trimmed, CFG.decimals);
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

export const InjectivePanel = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const { getMnemonic } = useStore(keyRingSelector);
  const { requestAuth, PasswordModal } = usePasswordGate();

  const [injAddress, setInjAddress] = useState('');
  const [qr, setQr] = useState('');
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
        setQr(await QRCode.toDataURL(addr, { margin: 1, width: 200 }));
      } catch (err) {
        console.error('[injective] failed to derive address:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isMnemonic, selectedKeyInfo, getMnemonic]);

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
  const scanKey = injectiveScanIndices(hdPeekQuery.data ?? 0)
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
          rows.push({ index: t.index, address: t.address, usdc: r.value.usdc, inj: r.value.inj });
        } else if (t.index === 0) {
          throw r.reason;
        }
      });
      return rows;
    },
  });
  const rows = useMemo(() => balancesQuery.data ?? [], [balancesQuery.data]);
  const mainRow = rows.find(r => r.index === 0);
  const burnerRows = fundedBurners(rows);

  // The ONE index the shield / withdraw forms act on. Every balance check, the
  // sponsor decision, the fee-grant grantee, and the signer's accountIndex all
  // derive from `selected`, so they can never disagree about which account.
  const [userPick, setUserPick] = useState<number | undefined>(undefined);
  const selectedIndex = resolveSelectedInjectiveIndex(rows, userPick);
  const selected = rows.find(r => r.index === selectedIndex);
  const selectedAddress = selected?.address ?? (selectedIndex === 0 ? injAddress : '');
  const usdcBal = selected?.usdc ?? 0n;
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
  const wantsSponsor = balancesReady && injBal < feeInj && usdcBal > 0n;
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

  const shieldBase = toBaseUnits(shieldAmount);
  const shieldExceeds = balancesReady && !!shieldBase && BigInt(shieldBase) > usdcBal;
  const withdrawBase = toBaseUnits(withdrawAmount);
  const withdrawExceeds = balancesReady && !!withdrawBase && BigInt(withdrawBase) > usdcBal;
  const withdrawAddrOk = isValidInjectiveAddress(withdrawAddr);
  // one send at a time: when both legs act on the same index an overlapping
  // shield + withdraw would collide on the sequence number.
  const anyBusy = isBusy(shieldTx.status) || isBusy(withdrawTx.status);

  const copy = useCallback(() => {
    if (!injAddress) {
      return;
    }
    void navigator.clipboard.writeText(injAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [injAddress]);

  const handleShield = useCallback(async () => {
    const base = toBaseUnits(shieldAmount);
    if (!base || !selectedKeyInfo || !CFG.penumbraChannel || !selectedAddress) {
      return;
    }
    if (!(await requestAuth())) {
      return;
    }
    setShieldTx({ status: 'signing' });
    try {
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
      const penumbraReceiver = await derivePenumbraEphemeralFromMnemonic(mnemonic, penumbraAccount);
      const sourceChannel = CFG.penumbraChannel; // channel-494 (injective -> penumbra)
      // No INJ for gas: get a fee allowance first. Resolves once it is on-chain.
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
          token: { denom: CFG.denom, amount: base },
          // 10-minute IBC timeout, in nanoseconds
          timeoutTimestamp: BigInt(Date.now() + 10 * 60 * 1000) * 1_000_000n,
          fee: injectiveFee(),
          feeGranter,
        });
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
      setShieldTx({ status: 'submitted', hash: res.txhash });
      setShieldAmount('');
      refetchBalances();
    } catch (err) {
      setShieldTx({ status: 'error', error: err instanceof Error ? err.message : 'shield failed' });
    }
  }, [
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
    const base = toBaseUnits(withdrawAmount);
    if (!base || !isValidInjectiveAddress(withdrawAddr) || !selectedKeyInfo || !selectedAddress) {
      return;
    }
    if (!(await requestAuth())) {
      return;
    }
    setWithdrawTx({ status: 'signing' });
    try {
      const mnemonic = await getMnemonic(selectedKeyInfo.id);
      if (!mnemonic) {
        throw new Error('wallet locked');
      }
      if ((await deriveInjectiveAddress(mnemonic, selectedIndex)) !== selectedAddress) {
        throw new Error('address/index mismatch - refresh and retry');
      }
      const res = await withdrawToExchange({
        mnemonic,
        accountIndex: selectedIndex,
        restUrl: CFG.restEndpoint,
        toAddress: withdrawAddr.trim(),
        amount: { denom: CFG.denom, amount: base },
        fee: injectiveFee(),
      });
      if (res.code !== 0) {
        throw new Error(res.rawLog || `broadcast failed (code ${res.code})`);
      }
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
    withdrawAmount,
    withdrawAddr,
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
        <div className='mb-2 text-xs font-medium lowercase'>your Injective address</div>
        <p className='mb-3 text-label text-fg-muted lowercase'>
          send USDC.inj here from an exchange, then shield it below. keep a little INJ for gas.
        </p>
        {qr && (
          <img src={qr} alt='inj address QR' className='mb-3 h-40 w-40 rounded bg-white p-1' />
        )}
        <div className='mb-3 flex items-center gap-2'>
          <span className='truncate font-mono text-xs' title={injAddress}>
            {injAddress || 'deriving...'}
          </span>
          <button
            type='button'
            onClick={copy}
            className='shrink-0 text-label text-fg-muted hover:text-fg-high'
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </div>

        {/* live balances */}
        <div className='rounded-md border border-border-soft bg-elev-1 p-3'>
          <div className='flex items-center justify-between'>
            <span className='text-label text-fg-muted lowercase'>balance</span>
            <button
              type='button'
              onClick={refetchBalances}
              disabled={!injAddress || isFetching}
              className='flex items-center gap-1 text-label text-fg-muted hover:text-fg-high disabled:opacity-50'
              title='refresh balance'
            >
              <span className={`i-lucide-refresh-cw h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
              refresh
            </button>
          </div>
          {balancesQuery.isError ? (
            <p className='mt-1 text-label text-red-400 lowercase'>
              couldn't load balance - retrying
            </p>
          ) : (
            <div className='mt-1 flex items-baseline justify-between'>
              <span className='font-mono text-lg'>
                {formatBaseUnits(mainRow?.usdc ?? 0n, CFG.decimals, 4)}{' '}
                <span className='text-xs text-fg-muted'>{CFG.symbol}</span>
              </span>
              <span className='font-mono text-xs text-fg-muted'>
                {formatBaseUnits(mainRow?.inj ?? 0n, GAS_ASSET.decimals, 6)} {GAS_ASSET.symbol}{' '}
                (gas)
              </span>
            </div>
          )}
          {/* funds on burner addresses (fresh unshield receivers). pick which
              address shield + withdraw act on. */}
          {burnerRows.length > 0 && (
            <div className='mt-2 border-t border-border-soft pt-2'>
              <div className='mb-1 text-label text-fg-muted lowercase'>
                other addresses - pick one to move
              </div>
              {(mainRow ? [mainRow, ...burnerRows] : burnerRows).map(r => {
                const active = r.index === selectedIndex;
                return (
                  <button
                    key={r.index}
                    type='button'
                    onClick={() => setUserPick(r.index)}
                    disabled={anyBusy}
                    title={r.address}
                    className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left font-mono text-label disabled:opacity-60 ${
                      active ? 'bg-elev-2 text-fg-high' : 'text-fg-muted hover:bg-elev-2'
                    }`}
                  >
                    <span
                      className={`h-3 w-3 shrink-0 ${
                        active ? 'i-ph-radio-button-fill text-zigner-gold' : 'i-ph-circle'
                      }`}
                    />
                    <span className='truncate'>
                      {r.index === 0 ? 'main' : shortInjAddress(r.address)}
                    </span>
                    <span className='ml-auto shrink-0'>
                      {formatBaseUnits(r.usdc, CFG.decimals, 2)} {CFG.symbol}
                    </span>
                    <span className='shrink-0'>
                      {formatBaseUnits(r.inj, GAS_ASSET.decimals, 4)} {GAS_ASSET.symbol}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {!gasOk &&
            (canSponsor ? (
              <p className='mt-2 text-label text-fg-muted lowercase'>
                no INJ needed - rotko pays the gas to shield. the sponsor is visible on-chain.
              </p>
            ) : (
              <p className='mt-2 text-label text-amber-400/90 lowercase'>
                not enough INJ for gas - send a little INJ here to move USDC (fee ~{feeDisplay}).
              </p>
            ))}
        </div>
      </div>

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
        <div className='relative mb-2'>
          <input
            type='number'
            min='0'
            step='any'
            value={shieldAmount}
            onChange={e => setShieldAmount(e.target.value)}
            placeholder='USDC amount'
            className='w-full rounded-lg border border-border-soft bg-input px-3 py-2 pr-14 text-sm focus:border-zigner-gold focus:outline-none'
          />
          <button
            type='button'
            onClick={() => setShieldAmount(fullDecimalString(usdcBal, CFG.decimals))}
            disabled={usdcBal === 0n}
            className='absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-label font-medium text-zigner-gold hover:bg-elev-1 disabled:opacity-40'
          >
            max
          </button>
        </div>
        <p className='mb-2 text-label text-fg-muted lowercase'>fee ~{feeDisplay}, paid in INJ.</p>
        {shieldExceeds && (
          <p className='mb-2 text-label text-amber-400/90 lowercase'>
            amount is more than your USDC.inj balance.
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
              : 'shield USDC to Penumbra'}
        </Button>
        {shieldTx.status === 'submitted' && (
          <p className='mt-2 text-label text-fg-muted lowercase'>
            submitted - included soon, then IBC-delivered to Penumbra.{' '}
            {shieldTx.hash && (
              <a
                href={EXPLORER_TX(shieldTx.hash)}
                target='_blank'
                rel='noreferrer'
                className='text-zigner-gold hover:underline'
              >
                view tx
              </a>
            )}
          </p>
        )}
        {shieldTx.status === 'done' && (
          <p className='mt-2 text-label text-green-400 lowercase'>
            included on Injective - IBC delivery to Penumbra is in flight.{' '}
            {shieldTx.hash && (
              <a
                href={EXPLORER_TX(shieldTx.hash)}
                target='_blank'
                rel='noreferrer'
                className='text-zigner-gold hover:underline'
              >
                view tx
              </a>
            )}
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
          placeholder='inj1... exchange deposit address'
          className='mb-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2 font-mono text-xs focus:border-zigner-gold focus:outline-none'
        />
        {withdrawAddr && !withdrawAddrOk && (
          <p className='mb-1 text-label text-red-400 lowercase'>
            not a valid Injective (inj1...) address.
          </p>
        )}
        <p className='mb-2 text-label leading-snug text-amber-400/90 lowercase'>
          inj1... only - the exchange's Injective USDC deposit address. a wrong-network address
          loses the funds.
        </p>
        <div className='relative mb-2'>
          <input
            type='number'
            min='0'
            step='any'
            value={withdrawAmount}
            onChange={e => setWithdrawAmount(e.target.value)}
            placeholder='USDC amount'
            className='w-full rounded-lg border border-border-soft bg-input px-3 py-2 pr-14 text-sm focus:border-zigner-gold focus:outline-none'
          />
          <button
            type='button'
            onClick={() => setWithdrawAmount(fullDecimalString(usdcBal, CFG.decimals))}
            disabled={usdcBal === 0n}
            className='absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-label font-medium text-zigner-gold hover:bg-elev-1 disabled:opacity-40'
          >
            max
          </button>
        </div>
        <p className='mb-2 text-label text-fg-muted lowercase'>fee ~{feeDisplay}, paid in INJ.</p>
        {withdrawExceeds && (
          <p className='mb-2 text-label text-amber-400/90 lowercase'>
            amount is more than your USDC.inj balance.
          </p>
        )}
        <Button
          className='w-full'
          disabled={!withdrawBase || withdrawExceeds || !withdrawAddrOk || !gasOk || anyBusy}
          onClick={() => void handleWithdraw()}
        >
          {withdrawTx.status === 'signing'
            ? 'sending...'
            : withdrawTx.status === 'submitted'
              ? 'confirming...'
              : 'withdraw USDC'}
        </Button>
        {withdrawTx.status === 'submitted' && (
          <p className='mt-2 text-label text-fg-muted lowercase'>
            submitted - waiting for inclusion.{' '}
            {withdrawTx.hash && (
              <a
                href={EXPLORER_TX(withdrawTx.hash)}
                target='_blank'
                rel='noreferrer'
                className='text-zigner-gold hover:underline'
              >
                view tx
              </a>
            )}
          </p>
        )}
        {withdrawTx.status === 'done' && (
          <p className='mt-2 text-label text-green-400 lowercase'>
            sent - included on Injective.{' '}
            {withdrawTx.hash && (
              <a
                href={EXPLORER_TX(withdrawTx.hash)}
                target='_blank'
                rel='noreferrer'
                className='text-zigner-gold hover:underline'
              >
                view tx
              </a>
            )}
          </p>
        )}
        {withdrawTx.status === 'error' && (
          <p className='mt-2 text-label text-red-400'>{withdrawTx.error}</p>
        )}
          </div>
        )}
      </div>

      {PasswordModal}
    </div>
  );
};
