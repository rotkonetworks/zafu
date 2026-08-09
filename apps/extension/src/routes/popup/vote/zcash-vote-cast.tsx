/**
 * Zcash vote casting and delegation flow - phase 2 (PCZT-based).
 *
 * State machine: idle - delegating (QR sign) - delegated - casting (per proposal) - done
 *
 * The delegation step is one-time per round; voting happens per proposal
 * after delegation. Each step wires to the voting service API (submitDelegation,
 * castVote) and worker functions for building PCZT objects.
 *
 * NOTE: Worker function calls are UI + flow state only. The actual cryptographic
 * parameter gathering (hotkeySecretHex, merkleWitnessesJson, etc.) is wired
 * separately in the state layer. This UI just drives the submission flow.
 */

import { useState, useCallback, useRef } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { submitDelegation, castVote } from '../../../services/voting/api';
import type { VotingRound, VotingServiceConfig } from '../../../services/voting/types';
import {
  buildDelegationPcztInWorker,
  finalizeDelegationInWorker,
  castVoteHotInWorker,
} from '../../../state/keyring/network-worker';
import { AnimatedQrDisplay } from '../../../shared/components/animated-qr-display';
import { AnimatedQrScanner } from '../../../shared/components/animated-qr-scanner';
import { unwrapCborSinglePczt, ZIGNER_PCZT_SIGNED_UR_TYPE } from '../send/zcash-send-cbor-helpers';
import {
  parseCompactResponse,
  POOL_ORCHARD,
  SUPPORTED_COMPACT_RESPONSE_VERSION,
} from '../../../state/keyring/compact-signing';

type VoteCastStep = 'idle' | 'delegating-qr-sign' | 'scan-delegation' | 'delegated' | 'casting-proposal' | 'done';

type CastProposalState = {
  proposalId: number;
  selectedOptionId: number | null;
  submitting: boolean;
  error: string | null;
};

interface ZcashVoteCastProps {
  round: VotingRound;
  config: VotingServiceConfig;
  walletId: string;
  onDelegated?: () => void;
  onVoteCast?: (proposalId: number, optionId: number) => void;
}

export const ZcashVoteCast = ({
  round,
  config,
  walletId,
  onDelegated,
  onVoteCast,
}: ZcashVoteCastProps) => {
  const [step, setStep] = useState<VoteCastStep>('idle');
  const [delegateError, setDelegateError] = useState<string | null>(null);
  const [delegateSubmitting, setDelegateSubmitting] = useState(false);
  const [delegationRejection, setDelegationRejection] = useState<{
    status: number;
    message: string;
  } | null>(null);

  // Per-proposal state for vote casting
  const [proposalStates, setProposalStates] = useState<Record<number, CastProposalState>>(
    () =>
      Object.fromEntries(
        round.proposals.map(p => [
          p.id,
          { proposalId: p.id, selectedOptionId: null, submitting: false, error: null },
        ]),
      ),
  );

  const unsignedDelegationRef = useRef<{
    redactedPcztHex: string;
    pcztSighashHex: string;
    rkHex: string;
    actionIndex: number;
    mainnet: boolean;
    urFrames: string[];
    cborBytes: number;
    contextJson: string;
    sighashHex: string;
    realNoteNullifiersHex: string[];
    dummyNoteNullifiersHex: string[];
    delegationStateJson: string;
  } | null>(null);

  // Gate on round status and config
  const canAct = round.status === 'active' && round.inConfig;
  const isDelegated = step !== 'idle' && step !== 'delegating-qr-sign' && step !== 'scan-delegation';

  // ─── Delegation Flow ───────────────────────────────────────────

  const handleStartDelegation = useCallback(async () => {
    setDelegateError(null);
    setDelegationRejection(null);
    setDelegateSubmitting(true);

    try {
      // Build the unsigned (redacted) delegation PCZT in the worker - phase 1 of 2.
      // TODO(crypto/integration): gather the real inputs before this call -
      //   - fvkHex / seedFingerprintHex / accountIndex: from the keyring for this wallet's orchard account
      //   - hotkeyPubkeyHex: from generateVotingHotkeyInWorker (persisted via saveVotingHotkey)
      //   - notesJson: the wallet's eligible orchard notes at round.snapshotHeight (from the worker note DB)
      //   - roundParamsJson: {vote_round_id, snapshot_height, ea_pk_hex, nc_root_hex, nullifier_imt_root_hex}
      //   - consensusBranchId: resolved from snapshotHeight via lightwalletd
      // network must be 'main'|'test'|'regtest' (NOT 'zcash').
      const unsigned = await buildDelegationPcztInWorker({
        network: 'main', // TODO(crypto): derive from the active network
        fvkHex: '', // TODO(crypto)
        seedFingerprintHex: '', // TODO(crypto)
        accountIndex: 0, // TODO(crypto)
        hotkeyPubkeyHex: '', // TODO(crypto)
        notesJson: '', // TODO(crypto)
        roundParamsJson: '', // TODO(crypto)
        consensusBranchId: 0, // TODO(crypto)
        roundName: round.title || round.id,
        bundleIndex: 0,
      });

      // Stash everything phase 2 (finalize) needs. delegationContextJson is
      // SENSITIVE (note rseed/rho + van_comm_rand) and long-lived across the
      // PIR fetch + air-gapped QR round-trip - TODO(security): persist it
      // ENCRYPTED (not a bare ref) so it survives popup teardown.
      unsignedDelegationRef.current = {
        redactedPcztHex: unsigned.redactedPcztHex,
        pcztSighashHex: unsigned.pcztSighashHex,
        rkHex: unsigned.rkHex,
        actionIndex: unsigned.actionIndex,
        mainnet: true, // TODO(crypto): derive from the active network
        urFrames: unsigned.urFrames,
        cborBytes: unsigned.cborBytes,
        contextJson: unsigned.delegationContextJson,
        sighashHex: unsigned.pcztSighashHex,
        realNoteNullifiersHex: unsigned.realNoteNullifiersHex,
        dummyNoteNullifiersHex: unsigned.dummyNoteNullifiersHex,
        delegationStateJson: unsigned.delegationStateJson,
      };

      // Transition to QR signing step
      setStep('delegating-qr-sign');
      setDelegateSubmitting(false);
    } catch (e) {
      setDelegateError(e instanceof Error ? e.message : 'failed to build delegation');
      setDelegateSubmitting(false);
    }
  }, [walletId, round.id]);

  /**
   * Called when the zigner QR scanner returns a signed PCZT response.
   * Parse the response envelope, extract the signature, and finalize the delegation.
   */
  const handleDelegationSignatureScanned = useCallback(
    async (envelopeBytes: Uint8Array) => {
      if (!unsignedDelegationRef.current) {
        setDelegateError('no unsigned delegation to sign');
        setStep('idle');
        return;
      }

      setStep('delegating-qr-sign');
      setDelegateError(null);
      setDelegationRejection(null);
      setDelegateSubmitting(true);

      try {
        // The device emits ur:zigner-module whose decoded payload is a CBOR {1: bytes}
        // wrap of the response envelope. Strip the CBOR envelope first.
        const responseEnvelope = unwrapCborSinglePczt(envelopeBytes);

        const ctx = unsignedDelegationRef.current;
        let spendAuthSigHex = '';

        // Check if this is a compact response (tx_type 0x07/0x08) or legacy (0x03)
        if (
          responseEnvelope.length >= 3 &&
          responseEnvelope[0] === 0x53 &&
          responseEnvelope[1] === 0x04
        ) {
          const txType = responseEnvelope[2];

          if (txType === 0x07 || txType === 0x08) {
            // Compact response: parse signatures and extract the one for our delegation action
            const { version, messages } = parseCompactResponse(responseEnvelope);
            if (version !== SUPPORTED_COMPACT_RESPONSE_VERSION) {
              throw new Error(
                `unsupported compact response version "${version}" (expected "${SUPPORTED_COMPACT_RESPONSE_VERSION}")`,
              );
            }

            // Single delegation = single message (pcztIndex: 0)
            const message = messages[0];
            if (!message) {
              throw new Error('compact response missing signatures');
            }

            // Find the signature for the delegation action at ctx.actionIndex in the orchard pool
            const sig = message.signatures.find(
              s => s.pool === POOL_ORCHARD && s.actionIndex === ctx.actionIndex,
            );
            if (!sig) {
              throw new Error(
                `signer did not return signature for delegation action ${ctx.actionIndex}`,
              );
            }

            // Convert 64-byte signature to hex
            for (let i = 0; i < sig.signature.length; i++) {
              spendAuthSigHex += sig.signature[i]!.toString(16).padStart(2, '0');
            }
          } else if (txType === 0x03) {
            // Legacy full-PCZT response: not supported for delegation (requires PCZT parsing)
            throw new Error(
              'received legacy full-PCZT response but delegation signing requires compact signatures-only mode',
            );
          } else {
            throw new Error(
              `unexpected response tx_type 0x${(txType ?? 0).toString(16)} in delegation signing`,
            );
          }
        } else {
          throw new Error('invalid response envelope format');
        }

        // Phase 2 of 2: prove ZKP #1 with the host-fetched IMT proofs + witnesses
        // and attach the cold signer's spend-auth sig - submission wire.
        const wireResult = await finalizeDelegationInWorker({
          delegationContextJson: ctx.contextJson,
          merkleWitnessesJson: '', // TODO(crypto): witnesses for the delegated notes
          imtProofsJson: '', // TODO(crypto): PIR-fetched IMT proofs for real+dummy nullifiers
          spendAuthSigHex,
          sighashHex: ctx.sighashHex,
        });

        // Submit delegation to vote servers
        const wireJson = wireResult.delegationSubmissionWireJson;
        const result = await submitDelegation(config, wireJson);

        if (result.ok) {
          unsignedDelegationRef.current = null;
          setStep('delegated');
          setDelegateSubmitting(false);
          onDelegated?.();
        } else {
          // 422 is deterministic - do not retry
          if ('rejected' in result && result.rejected) {
            setDelegationRejection({ status: result.status, message: result.message });
          }
          setStep('delegating-qr-sign');
          setDelegateSubmitting(false);
        }
      } catch (e) {
        setDelegateError(e instanceof Error ? e.message : 'failed to submit delegation');
        setStep('delegating-qr-sign');
        setDelegateSubmitting(false);
      }
    },
    [walletId, round, config, onDelegated],
  );

  // ─── Vote Casting Flow (per proposal) ───────────────────────────

  const handleSelectOption = useCallback(
    (proposalId: number, optionId: number) => {
      if (!isDelegated) {
        return;
      }
      setProposalStates(prev => ({
        ...prev,
        [proposalId]: { ...prev[proposalId]!, selectedOptionId: optionId },
      }));
    },
    [isDelegated],
  );

  const handleCastVote = useCallback(
    async (proposalId: number) => {
      const proposalState = proposalStates[proposalId];
      if (!proposalState || proposalState.selectedOptionId === null) {
        return;
      }

      setProposalStates(prev => ({
        ...prev,
        [proposalId]: { ...prev[proposalId]!, submitting: true, error: null },
      }));

      try {
        // Build the hot (non-QR) vote commitment PCZT
        // TODO(crypto): gather hotkeySecretHex, roundParamsJson, delegationStateJson,
        // vanWitnessJson, voteJson from keyring state and current vote selection.
        const voteResult = await castVoteHotInWorker({
          network: 'zcash',
          hotkeySecretHex: '', // TODO(crypto)
          roundParamsJson: '', // TODO(crypto): from round config
          delegationStateJson: '', // TODO(crypto): from delegation step result
          vanWitnessJson: '', // TODO(crypto)
          voteJson: JSON.stringify({
            roundId: round.id,
            proposalId,
            optionId: proposalState.selectedOptionId,
          }),
          submitAt: Math.floor(Date.now() / 1000),
        });

        // Submit vote to servers
        const wireJson = voteResult.wire;
        const result = await castVote(config, wireJson);

        if (result.ok) {
          setProposalStates(prev => ({
            ...prev,
            [proposalId]: {
              ...prev[proposalId]!,
              submitting: false,
              selectedOptionId: null,
            },
          }));
          onVoteCast?.(proposalId, proposalState.selectedOptionId);
        } else {
          // 422 is deterministic - do not retry
          if ('rejected' in result && result.rejected) {
            setProposalStates(prev => ({
              ...prev,
              [proposalId]: {
                ...prev[proposalId]!,
                submitting: false,
                error: `vote rejected: ${result.message}`,
              },
            }));
          }
        }
      } catch (e) {
        setProposalStates(prev => ({
          ...prev,
          [proposalId]: {
            ...prev[proposalId]!,
            submitting: false,
            error: e instanceof Error ? e.message : 'failed to cast vote',
          },
        }));
      }
    },
    [proposalStates, walletId, round, config, onVoteCast],
  );

  // ─── Rendering ─────────────────────────────────────────────────

  if (!canAct) {
    return (
      <div className='border-t border-border-soft pt-2 text-label text-fg-dim lowercase'>
        <span className='inline-flex items-center gap-1'>
          <span className='i-lucide-alert-circle h-3 w-3' />
          this round is not available for voting in zafu right now.
        </span>
      </div>
    );
  }

  return (
    <div className='border-t border-border-soft pt-3 flex flex-col gap-3'>
      {/* Delegation section */}
      {!isDelegated ? (
        <div className='flex flex-col gap-2'>
          <div className='text-label text-fg-muted'>
            delegate your voting power first, then cast votes per proposal.
          </div>

          {delegationRejection && (
            <div className='text-label text-red-400 bg-red-400/10 rounded-md p-2 border border-red-400/40'>
              <div className='font-medium'>delegation rejected</div>
              <div className='text-xs mt-1'>{delegationRejection.message}</div>
            </div>
          )}

          {delegateError && (
            <div className='text-label text-red-400 bg-red-400/10 rounded-md p-2 border border-red-400/40'>
              {delegateError}
            </div>
          )}

          {step === 'delegating-qr-sign' && unsignedDelegationRef.current && (
            <div className='flex flex-col gap-3'>
              <div className='text-label text-fg-high font-medium'>sign delegation with zafu zigner</div>

              {/* Animated QR display of unsigned delegation PCZT */}
              <AnimatedQrDisplay
                urFrames={unsignedDelegationRef.current.urFrames}
                totalBytes={unsignedDelegationRef.current.cborBytes}
                size={220}
                frameInterval={200}
                title='scan with zafu zigner'
                description='hold zigner camera steady; multi-frame transfer'
              />

              <div className='flex items-center justify-center gap-3 text-fg-muted'>
                <span className='flex items-center gap-1.5'>
                  <span className='i-lucide-smartphone h-4 w-4' />
                  <span className='text-xs'>open zigner</span>
                </span>
                <span className='i-lucide-chevron-right h-3 w-3 shrink-0' />
                <span className='flex items-center gap-1.5'>
                  <span className='i-lucide-scan h-4 w-4' />
                  <span className='text-xs'>scan</span>
                </span>
                <span className='i-lucide-chevron-right h-3 w-3 shrink-0' />
                <span className='flex items-center gap-1.5'>
                  <span className='i-lucide-check h-4 w-4' />
                  <span className='text-xs'>approve</span>
                </span>
              </div>

              <button
                onClick={() => setStep('scan-delegation')}
                className={cn(
                  'w-full py-2 px-3 rounded-md text-label font-medium transition-colors',
                  'bg-zigner-gold/20 text-zigner-gold',
                  'hover:bg-zigner-gold/30',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
                disabled={delegateSubmitting}
              >
                {delegateSubmitting ? 'submitting...' : 'scan signature from zafu zigner'}
              </button>

              <button
                onClick={() => setStep('idle')}
                className='text-label text-fg-muted hover:text-fg-high transition-colors'
              >
                cancel
              </button>
            </div>
          )}

          {step === 'scan-delegation' && (
            <AnimatedQrScanner
              onComplete={bytes => {
                void handleDelegationSignatureScanned(bytes);
              }}
              onError={err => {
                setDelegateError(err);
                setStep('delegating-qr-sign');
              }}
              onClose={() => setStep('delegating-qr-sign')}
              title='scan signed delegation'
              description='hold camera steady on the animated QR'
              urTypeFilter={ZIGNER_PCZT_SIGNED_UR_TYPE}
            />
          )}

          {step === 'idle' && (
            <button
              onClick={() => void handleStartDelegation()}
              disabled={delegateSubmitting}
              className={cn(
                'w-full py-2 px-3 rounded-md text-label font-medium transition-colors',
                'bg-zigner-gold/20 text-zigner-gold',
                'hover:bg-zigner-gold/30',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {delegateSubmitting ? 'building delegation...' : 'delegate voting power'}
            </button>
          )}
        </div>
      ) : (
        <div className='text-label text-fg-muted inline-flex items-center gap-1'>
          <span className='i-lucide-check h-3.5 w-3.5 text-zigner-gold' />
          voting power delegated - cast your votes below
        </div>
      )}

      {/* Vote casting section (only visible after delegation) */}
      {isDelegated && (
        <div className='flex flex-col gap-3 pt-1'>
          {round.proposals.map(proposal => {
            const pState = proposalStates[proposal.id]!;
            return (
              <div key={proposal.id} className='flex flex-col gap-1.5'>
                <div className='text-label text-fg-high'>{proposal.title || `proposal ${proposal.id}`}</div>

                {/* Option buttons */}
                <div className='flex flex-col gap-1'>
                  {proposal.options.map(opt => {
                    const isSelected = pState.selectedOptionId === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => handleSelectOption(proposal.id, opt.id)}
                        disabled={pState.submitting}
                        className={cn(
                          'flex items-center justify-between px-3 py-1.5 rounded-md text-label transition-colors',
                          isSelected
                            ? 'bg-zigner-gold/30 text-zigner-gold border border-zigner-gold/50'
                            : 'bg-elev-2 text-fg-muted hover:text-fg-high',
                          'disabled:opacity-50',
                        )}
                      >
                        <span>{opt.label}</span>
                        {isSelected && <span className='i-lucide-check h-3.5 w-3.5' />}
                      </button>
                    );
                  })}
                </div>

                {/* Cast button and errors */}
                <div className='flex flex-col gap-1'>
                  {pState.error && (
                    <div className='text-xs text-red-400 bg-red-400/10 rounded p-1.5 border border-red-400/40'>
                      {pState.error}
                    </div>
                  )}
                  <button
                    onClick={() => void handleCastVote(proposal.id)}
                    disabled={
                      pState.selectedOptionId === null ||
                      pState.submitting ||
                      !isDelegated
                    }
                    className={cn(
                      'w-full py-1.5 px-3 rounded-md text-label font-medium transition-colors',
                      'bg-elev-2 text-fg-muted',
                      'hover:bg-elev-1 hover:text-fg-high',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                  >
                    {pState.submitting ? 'casting...' : 'cast vote'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
