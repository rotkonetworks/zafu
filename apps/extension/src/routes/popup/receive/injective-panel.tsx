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

import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Button } from '@repo/ui/components/ui/button';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectPenumbraAccount, keyRingSelector } from '../../../state/keyring';
import { derivePenumbraEphemeralFromMnemonic } from '../../../hooks/use-address';
import { usePasswordGate } from '../../../hooks/password-gate';
import { COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import { deriveInjectiveAddress } from '@repo/wallet/networks/injective/derive';
import { shieldInToPenumbra, withdrawToExchange } from '@repo/wallet/networks/injective/conduit';

const CFG = COSMOS_CHAINS.injective;

/** fee is paid in the gas asset (INJ, 18-dec), NOT the ramp asset (USDC.inj). */
function injectiveFee() {
  const gas = '400000';
  const perGas = BigInt(/^\d+/.exec(CFG.gasPrice)?.[0] ?? '160000000');
  return {
    amount: [{ denom: CFG.gasAsset?.denom ?? 'inj', amount: (perGas * BigInt(gas)).toString() }],
    gas,
  };
}

/** USDC.inj is 6-dec; convert a human amount to integer base units. */
function toBaseUnits(human: string): string | undefined {
  const n = Number(human);
  if (!human || isNaN(n) || n <= 0) {
    return undefined;
  }
  return BigInt(Math.round(n * 10 ** CFG.decimals)).toString();
}

interface TxState {
  status: 'idle' | 'signing' | 'success' | 'error';
  hash?: string;
  error?: string;
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
    if (!base || !selectedKeyInfo || !CFG.penumbraChannel) {
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
      // fresh single-use Penumbra IBC deposit address for this shield-in
      const penumbraReceiver = await derivePenumbraEphemeralFromMnemonic(mnemonic, penumbraAccount);
      const res = await shieldInToPenumbra({
        mnemonic,
        restUrl: CFG.restEndpoint,
        sourceChannel: CFG.penumbraChannel, // channel-494 (injective -> penumbra)
        penumbraReceiver,
        token: { denom: CFG.denom, amount: base },
        // 10-minute IBC timeout, in nanoseconds
        timeoutTimestamp: BigInt(Date.now() + 10 * 60 * 1000) * 1_000_000n,
        fee: injectiveFee(),
      });
      if (res.code !== 0) {
        throw new Error(res.rawLog || `broadcast failed (code ${res.code})`);
      }
      setShieldTx({ status: 'success', hash: res.txhash });
      setShieldAmount('');
    } catch (err) {
      setShieldTx({ status: 'error', error: err instanceof Error ? err.message : 'shield failed' });
    }
  }, [shieldAmount, selectedKeyInfo, requestAuth, getMnemonic, penumbraAccount]);

  const handleWithdraw = useCallback(async () => {
    const base = toBaseUnits(withdrawAmount);
    if (!base || !withdrawAddr.startsWith('inj1') || !selectedKeyInfo) {
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
      const res = await withdrawToExchange({
        mnemonic,
        restUrl: CFG.restEndpoint,
        toAddress: withdrawAddr,
        amount: { denom: CFG.denom, amount: base },
        fee: injectiveFee(),
      });
      if (res.code !== 0) {
        throw new Error(res.rawLog || `broadcast failed (code ${res.code})`);
      }
      setWithdrawTx({ status: 'success', hash: res.txhash });
      setWithdrawAmount('');
    } catch (err) {
      setWithdrawTx({
        status: 'error',
        error: err instanceof Error ? err.message : 'withdraw failed',
      });
    }
  }, [withdrawAmount, withdrawAddr, selectedKeyInfo, requestAuth, getMnemonic]);

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
          withdraw USDC on Injective from Binance or Kraken to this address, then shield it into
          Penumbra below. gas is paid in INJ - keep a little INJ here to move USDC.
        </p>
        {qr && <img src={qr} alt='inj address QR' className='mb-3 h-40 w-40 rounded bg-white p-1' />}
        <div className='flex items-center gap-2'>
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
      </div>

      {/* shield in */}
      <div className='rounded-lg border border-border-soft p-4'>
        <div className='mb-2 text-xs font-medium lowercase'>shield into Penumbra</div>
        <input
          type='number'
          min='0'
          step='0.01'
          value={shieldAmount}
          onChange={e => setShieldAmount(e.target.value)}
          placeholder='USDC amount'
          className='mb-2 w-full rounded-lg border border-border-soft bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none'
        />
        <Button
          variant='gradient'
          className='w-full'
          disabled={!toBaseUnits(shieldAmount) || shieldTx.status === 'signing'}
          onClick={() => void handleShield()}
        >
          {shieldTx.status === 'signing' ? 'shielding...' : 'shield USDC to Penumbra'}
        </Button>
        {shieldTx.status === 'success' && (
          <p className='mt-2 text-label text-green-400'>shielded - tx {shieldTx.hash?.slice(0, 12)}...</p>
        )}
        {shieldTx.status === 'error' && (
          <p className='mt-2 text-label text-red-400'>{shieldTx.error}</p>
        )}
      </div>

      {/* withdraw */}
      <div className='rounded-lg border border-border-soft p-4'>
        <div className='mb-2 text-xs font-medium lowercase'>withdraw to an exchange</div>
        <input
          type='text'
          value={withdrawAddr}
          onChange={e => setWithdrawAddr(e.target.value.trim())}
          placeholder='inj1... exchange deposit address'
          className='mb-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2 font-mono text-xs focus:border-zigner-gold focus:outline-none'
        />
        <p className='mb-2 text-label leading-snug text-amber-400/90 lowercase'>
          must be an Injective-network deposit address (inj1...) that the exchange issued for USDC on
          Injective. sending to an Ethereum or other-network USDC address loses the funds.
        </p>
        <input
          type='number'
          min='0'
          step='0.01'
          value={withdrawAmount}
          onChange={e => setWithdrawAmount(e.target.value)}
          placeholder='USDC amount'
          className='mb-2 w-full rounded-lg border border-border-soft bg-input px-3 py-2 text-sm focus:border-zigner-gold focus:outline-none'
        />
        <Button
          className='w-full'
          disabled={
            !toBaseUnits(withdrawAmount) ||
            !withdrawAddr.startsWith('inj1') ||
            withdrawTx.status === 'signing'
          }
          onClick={() => void handleWithdraw()}
        >
          {withdrawTx.status === 'signing' ? 'sending...' : 'withdraw USDC'}
        </Button>
        {withdrawTx.status === 'success' && (
          <p className='mt-2 text-label text-green-400'>
            sent - tx {withdrawTx.hash?.slice(0, 12)}...
          </p>
        )}
        {withdrawTx.status === 'error' && (
          <p className='mt-2 text-label text-red-400'>{withdrawTx.error}</p>
        )}
      </div>

      {PasswordModal}
    </div>
  );
};
