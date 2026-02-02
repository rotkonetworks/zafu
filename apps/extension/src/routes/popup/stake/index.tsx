/**
 * penumbra staking page
 *
 * shows user delegations and allows delegate/undelegate
 */

import { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { StackIcon, ChevronDownIcon, Cross2Icon, UpdateIcon } from '@radix-ui/react-icons';
import { viewClient, stakeClient } from '../../../clients';
import { usePenumbraTransaction } from '../../../hooks/penumbra-transaction';
import { useStore } from '../../../state';
import { activeNetworkSelector } from '../../../state/active-network';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { getDisplayDenomFromView, getAssetIdFromValueView, getDisplayDenomExponentFromValueView } from '@penumbra-zone/getters/value-view';
import { fromValueView } from '@rotko/penumbra-types/amount';
import { assetPatterns } from '@rotko/penumbra-types/assets';
import { cn } from '@repo/ui/lib/utils';
import { ValidatorState_ValidatorStateEnum, type ValidatorInfo } from '@penumbra-zone/protobuf/penumbra/core/component/stake/v1/stake_pb';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { bech32mIdentityKey } from '@penumbra-zone/bech32m/penumbravalid';

/** staking token symbol */
const STAKING_TOKEN = 'UM';
const STAKING_EXPONENT = 6;

type StakeAction = 'delegate' | 'undelegate' | undefined;

interface ValidatorRow {
  info: ValidatorInfo;
  name: string;
  identity: string;
  votingPower: number;
  commission: number;
  state: string;
}

/** get validator state as string */
const getValidatorState = (info: ValidatorInfo): string => {
  const state = info.status?.state?.state;
  switch (state) {
    case ValidatorState_ValidatorStateEnum.ACTIVE: return 'active';
    case ValidatorState_ValidatorStateEnum.INACTIVE: return 'inactive';
    case ValidatorState_ValidatorStateEnum.JAILED: return 'jailed';
    case ValidatorState_ValidatorStateEnum.TOMBSTONED: return 'tombstoned';
    case ValidatorState_ValidatorStateEnum.DISABLED: return 'disabled';
    default: return 'unknown';
  }
};

/** check if a balance is a delegation token */
const isDelegationToken = (meta: { base?: string; symbol?: string } | undefined): boolean => {
  if (!meta) return false;
  // check base denom pattern - can be "delegation_" or "udelegation_" (micro-unit prefix)
  if (meta.base && (
    assetPatterns.delegationToken.matches(meta.base) ||
    meta.base.includes('delegation_penumbravalid1')
  )) {
    return true;
  }
  // fallback: check symbol
  if (meta.symbol && meta.symbol.includes('delegation_penumbravalid1')) {
    return true;
  }
  return false;
};

/** extract validator bech32 identity from delegation token base denom */
const getValidatorBech32FromDelegation = (meta: { base?: string } | undefined): string | undefined => {
  if (!meta?.base) return undefined;
  // base denom can be "delegation_penumbravalid1..." or "udelegation_penumbravalid1..." (with micro-unit prefix)
  // extract the bech32 part (penumbravalid1...)
  const match = meta.base.match(/u?delegation_(penumbravalid1[a-z0-9]+)/);
  return match?.[1];
};

/** find validator by matching delegation token to validator identity */
const findValidatorForDelegation = (
  meta: { base?: string } | undefined,
  validators: ValidatorRow[]
): ValidatorRow | undefined => {
  const delegationBech32 = getValidatorBech32FromDelegation(meta);
  if (!delegationBech32) return undefined;

  return validators.find(v => {
    if (!v.info.validator?.identityKey?.ik) return false;
    try {
      // convert validator identity key to bech32 and compare
      const validatorBech32 = bech32mIdentityKey({ ik: v.info.validator.identityKey.ik });
      return validatorBech32 === delegationBech32;
    } catch {
      return false;
    }
  });
};

/** Penumbra staking page */
export const StakePage = () => {
  const { activeNetwork } = useStore(activeNetworkSelector);
  const [action, setAction] = useState<StakeAction>(undefined);
  const [amount, setAmount] = useState('');
  const [selectedValidator, setSelectedValidator] = useState<ValidatorRow | undefined>();
  const [selectedDelegation, setSelectedDelegation] = useState<BalancesResponse | undefined>();
  const [txStatus, setTxStatus] = useState<'idle' | 'planning' | 'signing' | 'broadcasting' | 'success' | 'error'>('idle');
  const [txHash, setTxHash] = useState<string | undefined>();
  const [txError, setTxError] = useState<string | undefined>();

  const penumbraTx = usePenumbraTransaction();

  // only show for penumbra network
  if (activeNetwork !== 'penumbra') {
    return (
      <div className='flex flex-col items-center justify-center gap-4 p-6 pt-16 text-center'>
        <div className='rounded-full bg-primary/10 p-4'>
          <StackIcon className='h-8 w-8 text-primary' />
        </div>
        <div>
          <h2 className='text-lg font-semibold'>staking</h2>
          <p className='mt-1 text-sm text-muted-foreground'>
            staking is only available for penumbra network.
          </p>
        </div>
      </div>
    );
  }

  // fetch validators
  const { data: validators = [], isLoading: validatorsLoading, refetch: refetchValidators } = useQuery({
    queryKey: ['validators'],
    staleTime: 60_000,
    queryFn: async () => {
      const result: ValidatorRow[] = [];
      try {
        for await (const v of stakeClient.validatorInfo({})) {
          if (!v.validatorInfo) continue;
          const info = v.validatorInfo;
          const name = info.validator?.name || 'Unknown';
          const identity = info.validator?.identityKey?.ik
            ? Buffer.from(info.validator.identityKey.ik).toString('base64').slice(0, 8)
            : '';
          const votingPower = Number(info.status?.votingPower ?? 0n);
          // funding streams use a recipient oneof - get rate from recipient if available
          const fundingStream = info.validator?.fundingStreams?.[0];
          const commission = fundingStream?.recipient?.case === 'toAddress'
            ? Number(fundingStream.recipient.value.rateBps ?? 0) / 100
            : 0;
          const state = getValidatorState(info);
          result.push({ info, name, identity, votingPower, commission, state });
        }
        // sort by voting power
        result.sort((a, b) => b.votingPower - a.votingPower);
      } catch (err) {
        console.error('failed to fetch validators:', err);
      }
      return result;
    },
  });

  // fetch user balances to find delegations
  const { data: delegations = [], isLoading: delegationsLoading, refetch: refetchDelegations } = useQuery({
    queryKey: ['delegations', 0],
    staleTime: 30_000,
    queryFn: async () => {
      const result: BalancesResponse[] = [];
      try {
        for await (const b of viewClient.balances({ accountFilter: { account: 0 } })) {
          const meta = getMetadataFromBalancesResponse.optional(b);
          if (isDelegationToken(meta)) {
            result.push(b);
          }
        }
      } catch {
        // ignore
      }
      return result;
    },
  });

  // fetch staking token balance
  const { data: stakingBalance } = useQuery({
    queryKey: ['staking-balance', 0],
    staleTime: 30_000,
    queryFn: async () => {
      try {
        for await (const b of viewClient.balances({ accountFilter: { account: 0 } })) {
          const meta = getMetadataFromBalancesResponse.optional(b);
          if (meta?.symbol === STAKING_TOKEN) {
            if (!b.balanceView) return '0';
            const val = fromValueView(b.balanceView);
            return typeof val === 'string' ? val : val.toString();
          }
        }
      } catch {
        // ignore
      }
      return '0';
    },
  });

  // total voting power for percentage calculation
  const totalVotingPower = useMemo(() => {
    return validators.reduce((sum, v) => sum + v.votingPower, 0);
  }, [validators]);

  // handle delegate
  const handleDelegate = useCallback(async () => {
    if (!selectedValidator || !amount || parseFloat(amount) <= 0) return;

    setTxStatus('planning');
    setTxError(undefined);

    try {
      // convert to base units
      const baseAmount = BigInt(Math.floor(parseFloat(amount) * Math.pow(10, STAKING_EXPONENT)));

      const planRequest = new TransactionPlannerRequest({
        delegations: [{
          amount: new Amount({ lo: baseAmount, hi: 0n }),
          rateData: selectedValidator.info.rateData,
        }],
        source: { account: 0 },
      });

      setTxStatus('signing');
      const result = await penumbraTx.mutateAsync(planRequest);

      setTxStatus('success');
      setTxHash(result.txId);

      // reset form
      setAction(undefined);
      setAmount('');
      setSelectedValidator(undefined);

      // refetch data
      void refetchDelegations();
      void refetchValidators();
    } catch (err) {
      setTxStatus('error');
      setTxError(err instanceof Error ? err.message : 'delegation failed');
    }
  }, [selectedValidator, amount, penumbraTx, refetchDelegations, refetchValidators]);

  // handle undelegate
  const handleUndelegate = useCallback(async () => {
    if (!selectedDelegation || !amount || parseFloat(amount) <= 0) return;
    if (!selectedDelegation.balanceView) return;

    setTxStatus('planning');
    setTxError(undefined);

    try {
      const exponent = getDisplayDenomExponentFromValueView(selectedDelegation.balanceView);
      const assetId = getAssetIdFromValueView(selectedDelegation.balanceView);
      const baseAmount = BigInt(Math.floor(parseFloat(amount) * Math.pow(10, exponent)));

      // find the validator for this delegation
      const meta = getMetadataFromBalancesResponse.optional(selectedDelegation);
      const validator = findValidatorForDelegation(meta, validators);

      if (!validator) {
        throw new Error('validator not found for delegation');
      }

      const planRequest = new TransactionPlannerRequest({
        undelegations: [{
          rateData: validator.info.rateData,
          value: {
            amount: new Amount({ lo: baseAmount, hi: 0n }),
            assetId,
          },
        }],
        source: { account: 0 },
      });

      setTxStatus('signing');
      const result = await penumbraTx.mutateAsync(planRequest);

      setTxStatus('success');
      setTxHash(result.txId);

      // reset form
      setAction(undefined);
      setAmount('');
      setSelectedDelegation(undefined);

      // refetch data
      void refetchDelegations();
      void refetchValidators();
    } catch (err) {
      setTxStatus('error');
      setTxError(err instanceof Error ? err.message : 'undelegation failed');
    }
  }, [selectedDelegation, amount, validators, penumbraTx, refetchDelegations, refetchValidators]);

  const closeForm = useCallback(() => {
    setAction(undefined);
    setAmount('');
    setSelectedValidator(undefined);
    setSelectedDelegation(undefined);
    setTxStatus('idle');
    setTxHash(undefined);
    setTxError(undefined);
  }, []);

  // delegation/undelegate form modal
  if (action) {
    const isDelegate = action === 'delegate';
    const canSubmit = isDelegate
      ? selectedValidator && amount && parseFloat(amount) > 0
      : selectedDelegation && amount && parseFloat(amount) > 0;

    const maxAmount = isDelegate
      ? stakingBalance || '0'
      : selectedDelegation?.balanceView
        ? (() => {
          const val = fromValueView(selectedDelegation.balanceView);
          return typeof val === 'string' ? val : val.toString();
        })()
        : '0';

    return (
      <div className='flex flex-col gap-4 p-4'>
        {/* header */}
        <div className='flex items-center justify-between'>
          <h2 className='text-lg font-semibold'>{isDelegate ? 'delegate' : 'undelegate'}</h2>
          <button onClick={closeForm} className='text-muted-foreground hover:text-foreground'>
            <Cross2Icon className='h-5 w-5' />
          </button>
        </div>

        {/* validator/delegation selector */}
        {isDelegate ? (
          <div>
            <label className='mb-1 block text-xs text-muted-foreground'>validator</label>
            <select
              value={selectedValidator ? validators.indexOf(selectedValidator) : ''}
              onChange={e => setSelectedValidator(validators[parseInt(e.target.value, 10)])}
              className='w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground'
            >
              <option value=''>select validator...</option>
              {validators.filter(v => v.state === 'active').map((v, i) => (
                <option key={i} value={i}>
                  {v.name} ({(v.votingPower / totalVotingPower * 100).toFixed(2)}%)
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div>
            <label className='mb-1 block text-xs text-muted-foreground'>delegation</label>
            <select
              value={selectedDelegation ? delegations.indexOf(selectedDelegation) : ''}
              onChange={e => setSelectedDelegation(delegations[parseInt(e.target.value, 10)])}
              className='w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground'
            >
              <option value=''>select delegation...</option>
              {delegations.map((d, i) => {
                const symbol = d.balanceView ? getDisplayDenomFromView(d.balanceView) : 'Unknown';
                const bal = d.balanceView ? fromValueView(d.balanceView) : '0';
                const balStr = typeof bal === 'string' ? bal : bal.toString();
                return (
                  <option key={i} value={i}>
                    {symbol} ({balStr})
                  </option>
                );
              })}
            </select>
          </div>
        )}

        {/* amount */}
        <div>
          <div className='mb-1 flex items-center justify-between'>
            <label className='text-xs text-muted-foreground'>amount</label>
            <button
              onClick={() => setAmount(maxAmount)}
              className='text-xs text-zigner-gold hover:text-zigner-gold-light'
            >
              max: {maxAmount}
            </button>
          </div>
          <input
            type='text'
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder='0.00'
            className='w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground'
          />
        </div>

        {/* tx status */}
        {txStatus === 'success' && txHash && (
          <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3'>
            <p className='text-sm text-green-400'>{isDelegate ? 'delegation' : 'undelegation'} successful!</p>
            <p className='text-xs text-muted-foreground mt-1 font-mono break-all'>{txHash}</p>
          </div>
        )}

        {txStatus === 'error' && txError && (
          <div className='rounded-lg border border-red-500/30 bg-red-500/10 p-3'>
            <p className='text-sm text-red-400'>transaction failed</p>
            <p className='text-xs text-muted-foreground mt-1'>{txError}</p>
          </div>
        )}

        {/* submit */}
        <button
          onClick={() => {
            if (txStatus === 'success' || txStatus === 'error') {
              closeForm();
            } else if (isDelegate) {
              void handleDelegate();
            } else {
              void handleUndelegate();
            }
          }}
          disabled={
            (txStatus === 'idle' && !canSubmit) ||
            txStatus === 'planning' ||
            txStatus === 'signing' ||
            txStatus === 'broadcasting'
          }
          className={cn(
            'w-full rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark',
            'transition-all hover:bg-zigner-gold-light disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {txStatus === 'planning' && 'building plan...'}
          {txStatus === 'signing' && 'signing...'}
          {txStatus === 'broadcasting' && 'broadcasting...'}
          {txStatus === 'idle' && (isDelegate ? 'delegate' : 'undelegate')}
          {(txStatus === 'success' || txStatus === 'error') && 'done'}
        </button>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-4 p-4'>
      {/* header */}
      <div className='flex items-center justify-between'>
        <h2 className='text-lg font-semibold'>staking</h2>
        <button
          onClick={() => { void refetchValidators(); void refetchDelegations(); }}
          className='text-muted-foreground hover:text-foreground'
        >
          <UpdateIcon className='h-4 w-4' />
        </button>
      </div>

      {/* staking balance */}
      <div className='rounded-lg border border-border/50 bg-muted/20 p-4'>
        <p className='text-xs text-muted-foreground'>available to stake</p>
        <p className='text-xl font-semibold'>{stakingBalance || '0'} {STAKING_TOKEN}</p>
        <button
          onClick={() => setAction('delegate')}
          className='mt-2 w-full rounded bg-zigner-gold py-2 text-sm font-medium text-zigner-dark hover:bg-zigner-gold-light'
        >
          delegate
        </button>
      </div>

      {/* user delegations */}
      <div>
        <h3 className='mb-2 text-sm font-medium text-muted-foreground'>your delegations</h3>
        {delegationsLoading ? (
          <div className='flex items-center gap-2 py-4 text-sm text-muted-foreground'>
            <UpdateIcon className='h-4 w-4 animate-spin' />
            loading...
          </div>
        ) : delegations.length === 0 ? (
          <p className='py-4 text-sm text-muted-foreground'>no active delegations</p>
        ) : (
          <div className='flex flex-col gap-2'>
            {delegations.map((d, i) => {
              const bal = d.balanceView ? fromValueView(d.balanceView) : '0';
              const balStr = typeof bal === 'string' ? bal : bal.toString();

              // find matching validator by delegation token
              const meta = getMetadataFromBalancesResponse.optional(d);
              const matchedValidator = findValidatorForDelegation(meta, validators);

              // show validator name, or fallback to truncated address
              const fallbackAddr = meta?.base?.replace(/u?delegation_/, '').slice(0, 20) + '...';
              const displayName = matchedValidator?.name || fallbackAddr;

              return (
                <div
                  key={i}
                  className='flex items-center justify-between rounded-lg border border-border/50 bg-muted/10 p-3'
                >
                  <div className='min-w-0 flex-1'>
                    <p className='text-sm font-medium truncate'>{displayName}</p>
                    <p className='text-xs text-muted-foreground'>
                      {balStr} staked
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setSelectedDelegation(d);
                      setAction('undelegate');
                    }}
                    className='ml-2 rounded bg-muted/50 px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground'
                  >
                    undelegate
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* validators */}
      <div>
        <h3 className='mb-2 text-sm font-medium text-muted-foreground'>
          validators ({validators.filter(v => v.state === 'active').length} active)
        </h3>
        {validatorsLoading ? (
          <div className='flex items-center gap-2 py-4 text-sm text-muted-foreground'>
            <UpdateIcon className='h-4 w-4 animate-spin' />
            loading validators...
          </div>
        ) : (
          <div className='flex flex-col gap-1 max-h-64 overflow-y-auto'>
            {validators.filter(v => v.state === 'active').slice(0, 20).map((v, i) => {
              const pct = totalVotingPower > 0 ? (v.votingPower / totalVotingPower * 100) : 0;
              return (
                <button
                  key={i}
                  onClick={() => {
                    setSelectedValidator(v);
                    setAction('delegate');
                  }}
                  className='flex items-center justify-between rounded-lg border border-border/30 bg-muted/10 p-2 text-left hover:bg-muted/30 transition-colors'
                >
                  <div className='flex-1 min-w-0'>
                    <p className='text-sm font-medium truncate'>{v.name}</p>
                    <p className='text-xs text-muted-foreground'>
                      {pct.toFixed(2)}% · {v.commission}% fee
                    </p>
                  </div>
                  <ChevronDownIcon className='h-4 w-4 text-muted-foreground rotate-[-90deg]' />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
