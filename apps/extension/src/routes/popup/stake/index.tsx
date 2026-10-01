/**
 * penumbra staking page
 *
 * shows user delegations and allows delegate/undelegate
 */

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sensitive } from '../../../components/sensitive';
import { viewClient, stakeClient } from '../../../clients';
import { useStore } from '../../../state';
import { selectActiveNetwork, selectPenumbraAccount } from '../../../state/keyring';
import { hasFeature } from '../../../config/networks';
import { NetworkUnavailable } from '../../../shared/components/network-unavailable';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import {
  getDisplayDenomFromView,
  getAssetIdFromValueView,
  getDisplayDenomExponentFromValueView,
} from '@penumbra-zone/getters/value-view';
import { fromValueView } from '@rotko/penumbra-types/amount';
import { assetPatterns } from '@rotko/penumbra-types/assets';
import { Button } from '@repo/ui/components/ui/button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { ScreenHeader } from '../../../components/screen-header';
import { PenumbraFlow } from '../send/penumbra-flow';
import { Figure, Footer, Main } from '../send/send-ui';
import { AmountField, PickSheet } from '../send/send-fields';
import {
  ValidatorState_ValidatorStateEnum,
  type ValidatorInfo,
} from '@penumbra-zone/protobuf/penumbra/core/component/stake/v1/stake_pb';
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
    case ValidatorState_ValidatorStateEnum.ACTIVE:
      return 'active';
    case ValidatorState_ValidatorStateEnum.INACTIVE:
      return 'inactive';
    case ValidatorState_ValidatorStateEnum.JAILED:
      return 'jailed';
    case ValidatorState_ValidatorStateEnum.TOMBSTONED:
      return 'tombstoned';
    case ValidatorState_ValidatorStateEnum.DISABLED:
      return 'disabled';
    default:
      return 'unknown';
  }
};

/** check if a balance is a delegation token */
const isDelegationToken = (meta: { base?: string; symbol?: string } | undefined): boolean => {
  if (!meta) {
    return false;
  }
  // check base denom pattern - can be "delegation_" or "udelegation_" (micro-unit prefix)
  if (
    meta.base &&
    (assetPatterns.delegationToken.matches(meta.base) ||
      meta.base.includes('delegation_penumbravalid1'))
  ) {
    return true;
  }
  // fallback: check symbol
  if (meta.symbol?.includes('delegation_penumbravalid1')) {
    return true;
  }
  return false;
};

/** extract validator bech32 identity from delegation token base denom */
const getValidatorBech32FromDelegation = (
  meta: { base?: string } | undefined,
): string | undefined => {
  if (!meta?.base) {
    return undefined;
  }
  // base denom can be "delegation_penumbravalid1..." or "udelegation_penumbravalid1..." (with micro-unit prefix)
  // extract the bech32 part (penumbravalid1...)
  const match = /u?delegation_(penumbravalid1[a-z0-9]+)/.exec(meta.base);
  return match?.[1];
};

/** find validator by matching delegation token to validator identity */
const findValidatorForDelegation = (
  meta: { base?: string } | undefined,
  validators: ValidatorRow[],
): ValidatorRow | undefined => {
  const delegationBech32 = getValidatorBech32FromDelegation(meta);
  if (!delegationBech32) {
    return undefined;
  }

  return validators.find(v => {
    if (!v.info.validator?.identityKey?.ik) {
      return false;
    }
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
  const activeNetwork = useStore(selectActiveNetwork);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const [action, setAction] = useState<StakeAction>(undefined);
  const [amount, setAmount] = useState('');
  const [selectedValidator, setSelectedValidator] = useState<ValidatorRow | undefined>();
  const [selectedDelegation, setSelectedDelegation] = useState<BalancesResponse | undefined>();
  const [pickOpen, setPickOpen] = useState(false);

  // gate network-only queries via the hook's `enabled` flag rather than an
  // early return - Rules of Hooks require the same hook count on every render.
  const canStake = hasFeature(activeNetwork, 'stake');

  // fetch validators
  const {
    data: validators = [],
    isLoading: validatorsLoading,
    refetch: refetchValidators,
  } = useQuery({
    queryKey: ['validators'],
    enabled: canStake,
    staleTime: 60_000,
    queryFn: async () => {
      const result: ValidatorRow[] = [];
      try {
        for await (const v of stakeClient.validatorInfo({})) {
          if (!v.validatorInfo) {
            continue;
          }
          const info = v.validatorInfo;
          const name = info.validator?.name || 'Unknown';
          const identity = info.validator?.identityKey?.ik
            ? Buffer.from(info.validator.identityKey.ik).toString('base64').slice(0, 8)
            : '';
          // votingPower is an Amount {lo, hi} (uint128), not a number - reading
          // it directly gives NaN and every share renders 0.00%. It fits in the
          // low 64 bits, so lo is the value.
          const votingPower = Number(info.status?.votingPower?.lo ?? 0n);
          // A validator's commission is the SUM of the rate_bps across ALL its
          // funding streams, not just the first, and a stream directs rewards to
          // EITHER an address OR the community pool - both carry a rate_bps. The
          // old code read only fundingStreams[0] and only when it was `toAddress`,
          // so a validator whose commission stream is `toCommunityPool` (or simply
          // not first) rendered 0% - e.g. a 100%-commission validator showing 0%.
          // rate_bps is basis points (10000 bps = 100%), so /100 gives percent.
          const commissionBps = (info.validator?.fundingStreams ?? []).reduce((sum, fs) => {
            const r = fs.recipient;
            if (r?.case === 'toAddress' || r?.case === 'toCommunityPool') {
              return sum + Number(r.value.rateBps ?? 0);
            }
            return sum;
          }, 0);
          const commission = commissionBps / 100;
          const state = getValidatorState(info);
          result.push({ info, name, identity, votingPower, commission, state });
        }
        // Rank by a blended "small + cheap" score so decentralization-friendly
        // picks (low stake, low commission) surface first rather than the
        // whales. Deliberately vendor-neutral - we do NOT pin rotko.net (or any
        // operator) to the top; ranking is purely on stake + commission. Each
        // factor is normalized to [0,1] across the set so stake (a huge raw
        // number) and commission (a single-digit percent) carry comparable
        // weight; lower score = better.
        const maxVotingPower = Math.max(1, ...result.map(v => v.votingPower));
        const maxCommission = Math.max(0.0001, ...result.map(v => v.commission));
        // weights sum to 1 - tune to favour stake vs commission
        const STAKE_WEIGHT = 0.5;
        const COMMISSION_WEIGHT = 0.5;
        const score = (v: ValidatorRow) =>
          STAKE_WEIGHT * (v.votingPower / maxVotingPower) +
          COMMISSION_WEIGHT * (v.commission / maxCommission);
        result.sort((a, b) => score(a) - score(b));
      } catch (err) {
        console.error('failed to fetch validators:', err);
      }
      return result;
    },
  });

  // fetch user balances to find delegations
  const {
    data: delegations = [],
    isLoading: delegationsLoading,
    refetch: refetchDelegations,
  } = useQuery({
    queryKey: ['delegations', penumbraAccount],
    enabled: canStake,
    staleTime: 30_000,
    queryFn: async () => {
      const result: BalancesResponse[] = [];
      try {
        for await (const b of viewClient.balances({
          accountFilter: { account: penumbraAccount },
        })) {
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
    queryKey: ['staking-balance', penumbraAccount],
    enabled: canStake,
    staleTime: 30_000,
    queryFn: async () => {
      try {
        for await (const b of viewClient.balances({
          accountFilter: { account: penumbraAccount },
        })) {
          const meta = getMetadataFromBalancesResponse.optional(b);
          if (meta?.symbol === STAKING_TOKEN) {
            if (!b.balanceView) {
              return '0';
            }
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

  // The delegate dropdown only offers active validators. The <select> value and
  // onChange MUST index this same filtered list - indexing the unfiltered
  // `validators` array with a filtered position selects (and then delegates to)
  // the wrong validator.
  const activeValidators = useMemo(
    () => validators.filter(v => v.state === 'active'),
    [validators],
  );

  const planDelegate = async () => {
    // to base units
    const baseAmount = BigInt(Math.floor(parseFloat(amount) * Math.pow(10, STAKING_EXPONENT)));
    return new TransactionPlannerRequest({
      delegations: [
        {
          amount: new Amount({ lo: baseAmount, hi: 0n }),
          rateData: selectedValidator!.info.rateData,
        },
      ],
      source: { account: penumbraAccount },
    });
  };

  const planUndelegate = async () => {
    const view = selectedDelegation!.balanceView!;
    const exponent = getDisplayDenomExponentFromValueView(view);
    const assetId = getAssetIdFromValueView(view);
    const baseAmount = BigInt(Math.floor(parseFloat(amount) * Math.pow(10, exponent)));
    const validator = findValidatorForDelegation(
      getMetadataFromBalancesResponse.optional(selectedDelegation),
      validators,
    );
    if (!validator) {
      throw new Error("this delegation's validator isn't listed right now");
    }
    return new TransactionPlannerRequest({
      undelegations: [
        {
          rateData: validator.info.rateData,
          value: { amount: new Amount({ lo: baseAmount, hi: 0n }), assetId },
        },
      ],
      source: { account: penumbraAccount },
    });
  };

  const closeForm = () => {
    setAction(undefined);
    setAmount('');
    setSelectedValidator(undefined);
    setSelectedDelegation(undefined);
  };

  // placed after every hook so the count stays consistent across network
  // switches (was triggering React #300).
  if (!canStake) {
    return <NetworkUnavailable feature='staking' iconClass='i-ph-stack' />;
  }

  const delegationName = (d: BalancesResponse) => {
    const meta = getMetadataFromBalancesResponse.optional(d);
    return (
      findValidatorForDelegation(meta, validators)?.name ??
      `${meta?.base?.replace(/u?delegation_/, '').slice(0, 20)}…`
    );
  };
  const balanceOf = (d: BalancesResponse) => {
    const val = d.balanceView ? fromValueView(d.balanceView) : '0';
    return typeof val === 'string' ? val : val.toString();
  };
  const share = (v: ValidatorRow) =>
    `${(totalVotingPower > 0 ? (v.votingPower / totalVotingPower) * 100 : 0).toFixed(2)}% · ${v.commission}% fee`;

  if (action) {
    const isDelegate = action === 'delegate';
    const unit = isDelegate
      ? STAKING_TOKEN.toLowerCase()
      : selectedDelegation?.balanceView
        ? getDisplayDenomFromView(selectedDelegation.balanceView).toLowerCase()
        : 'delegation';
    const maxAmount = isDelegate
      ? stakingBalance || '0'
      : selectedDelegation
        ? balanceOf(selectedDelegation)
        : '0';
    const target = isDelegate
      ? selectedValidator?.name
      : selectedDelegation && delegationName(selectedDelegation);
    const canReview = !!target && parseFloat(amount) > 0;
    const line = (
      <>
        <Sensitive>{`${amount} ${unit}`}</Sensitive>{' '}
        {isDelegate ? `delegated to ${target}` : `undelegated from ${target}`}
      </>
    );

    return (
      <PenumbraFlow
        onClose={closeForm}
        tx={{
          sending: line,
          label: `${action} ${amount}`,
          plan: isDelegate ? planDelegate : planUndelegate,
          onSent: () => {
            void refetchDelegations();
            void refetchValidators();
          },
          review: {
            lead: isDelegate ? 'you delegate' : 'you undelegate',
            amount,
            unit,
            rows: [
              [isDelegate ? 'to' : 'from', target ?? ''],
              ...(isDelegate && selectedValidator
                ? [['commission', `${selectedValidator.commission}%`] as const]
                : []),
              ['fee', 'shown before you approve'],
            ],
            privacy: 'the staked amount is public on chain',
            confirm: isDelegate ? 'delegate' : 'undelegate',
          },
          done: line,
        }}
      >
        {review => (
          <>
            <ScreenHeader title={action} onBack={closeForm} />
            <Main className='gap-[18px] pt-5'>
              <RowGroup>
                <Row
                  type='value'
                  label={isDelegate ? 'validator' : 'delegation'}
                  value={target ?? 'choose'}
                  onPress={() => setPickOpen(true)}
                />
              </RowGroup>
              <AmountField
                value={amount}
                onChange={setAmount}
                unit={unit}
                available={maxAmount}
                onMax={() => setAmount(maxAmount)}
              />
            </Main>
            <Footer>
              <Button onClick={review} disabled={!canReview} className='w-full'>
                review
              </Button>
            </Footer>
            {isDelegate ? (
              <PickSheet
                title='validator'
                open={pickOpen}
                onOpenChange={setPickOpen}
                picks={activeValidators.map((v, i) => ({
                  key: i,
                  label: v.name,
                  description: share(v),
                }))}
                onPick={i => setSelectedValidator(activeValidators[i])}
              />
            ) : (
              <PickSheet
                title='delegation'
                open={pickOpen}
                onOpenChange={setPickOpen}
                picks={delegations.map((d, i) => ({
                  key: i,
                  label: delegationName(d),
                  value: balanceOf(d),
                }))}
                onPick={i => setSelectedDelegation(delegations[i])}
                empty='no delegations yet'
              />
            )}
          </>
        )}
      </PenumbraFlow>
    );
  }

  return (
    <div className='flex h-full flex-col'>
      <ScreenHeader
        title='stake'
        meta={
          <button
            onClick={() => {
              void refetchValidators();
              void refetchDelegations();
            }}
            aria-label='refresh'
            className='grid size-8 place-items-center text-fg-muted transition-colors hover:text-fg-high'
          >
            <span className='i-ph-arrows-clockwise size-4' />
          </button>
        }
      />
      <Main className='gap-[18px] pt-5'>
        <div className='flex flex-col gap-1.5'>
          <span className='text-xs text-fg-muted'>available to stake</span>
          <Figure amount={stakingBalance || '0'} unit={STAKING_TOKEN.toLowerCase()} />
        </div>

        <section className='flex flex-col gap-2'>
          <span className='text-xs text-fg-muted'>your delegations</span>
          {delegationsLoading ? (
            <div className='h-[52px] animate-pulse bg-elev-1' />
          ) : delegations.length === 0 ? (
            <p className='border border-border-soft px-3.5 py-4 text-xs text-fg-muted'>
              nothing delegated yet
            </p>
          ) : (
            <RowGroup>
              {delegations.map((d, i) => (
                <Row
                  key={i}
                  type='screen'
                  label={delegationName(d)}
                  description={`${balanceOf(d)} staked · undelegate`}
                  onPress={() => {
                    setSelectedDelegation(d);
                    setAction('undelegate');
                  }}
                />
              ))}
            </RowGroup>
          )}
        </section>

        <section className='flex flex-col gap-2 pb-4'>
          <span className='text-xs text-fg-muted'>
            validators · {activeValidators.length} active
          </span>
          {validatorsLoading ? (
            <div className='h-[52px] animate-pulse bg-elev-1' />
          ) : (
            <RowGroup>
              {activeValidators.slice(0, 20).map((v, i) => (
                <Row
                  key={i}
                  type='screen'
                  label={v.name}
                  description={share(v)}
                  onPress={() => {
                    setSelectedValidator(v);
                    setAction('delegate');
                  }}
                />
              ))}
            </RowGroup>
          )}
        </section>
      </Main>
      <Footer>
        <Button onClick={() => setAction('delegate')} className='w-full'>
          delegate
        </Button>
      </Footer>
    </div>
  );
};
