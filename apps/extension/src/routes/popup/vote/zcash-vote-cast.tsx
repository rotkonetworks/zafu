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
  generateVotingHotkeyInWorker,
  getOrchardAccountInfoInWorker,
  getConsensusBranchIdInWorker,
  getMerkleWitnessesInWorker,
  getPoolNotesInWorker,
  pirFetchImtProofsInWorker,
  type DecryptedNoteWithTxid,
} from '../../../state/keyring/network-worker';
import { AnimatedQrDisplay } from '../../../shared/components/animated-qr-display';
import { AnimatedQrScanner } from '../../../shared/components/animated-qr-scanner';
import { unwrapCborSinglePczt, ZIGNER_PCZT_SIGNED_UR_TYPE } from '../send/zcash-send-cbor-helpers';
import {
  parseCompactResponse,
  POOL_ORCHARD,
  SUPPORTED_COMPACT_RESPONSE_VERSION,
} from '../../../state/keyring/compact-signing';
import { useStore } from '../../../state';
import { selectGetMnemonic } from '../../../state/keyring';
import { seedFingerprintHex } from '@repo/wallet/networks/zcash/seed-fingerprint';
import { nu63ActivationHeight } from '../../../config/feature-flags';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import {
  saveVotingHotkey,
  loadVotingRoundRecord,
  saveDelegationState,
} from '../../../services/voting/persistence';

// zafu's zcash accounts are single-ZIP32-account and mainnet-only today (same
// convention as ZcashSend: `accountIndex={0} mainnet={true}`, send/index.tsx).
const VOTING_ACCOUNT_INDEX = 0;
const VOTING_MAINNET = true;
// build_delegation_pczt / generate_voting_hotkey / cast_vote_hot_wire take the
// voting-wasm network string ("main"|"test"|"regtest"), NOT the NetworkType
// ('zcash') used to route calls to the right worker.
const VOTING_WASM_NETWORK = 'main';

/** RoundConfigEntry.ea_pk (and legacy round ids) arrive base64-encoded. */
const base64ToHex = (b64: string): string =>
  Array.from(
    Uint8Array.from(atob(b64), c => c.charCodeAt(0)),
    b => b.toString(16).padStart(2, '0'),
  ).join('');

/**
 * Eligible notes for a round's delegation: unspent, at or below the
 * snapshot height. valar/ZODL rounds predate NU6.3 (orchard notes); a round
 * whose snapshot height is past NU6.3 activation is an ironwood-pool round
 * instead - orchard-to-orchard spends are consensus-disabled post-NU6.3, so
 * a wallet holding notes across the upgrade only has one spendable pool at
 * any given snapshot height.
 */
const notePoolForSnapshot = (snapshotHeight: number): 'orchard' | 'ironwood' =>
  snapshotHeight >= nu63ActivationHeight(VOTING_MAINNET) ? 'ironwood' : 'orchard';

const eligibleNotesAtSnapshot = (
  notes: DecryptedNoteWithTxid[],
  snapshotHeight: number,
): DecryptedNoteWithTxid[] => notes.filter(n => !n.spent && n.height <= snapshotHeight);

/** DecryptedNoteWithTxid -> voting-wasm NoteInfoDto (snake_case, hex/number
 *  as the Rust side expects - see voting-wasm's voting_delegation.rs). */
const toNoteInfoDto = (n: DecryptedNoteWithTxid, ufvkStr: string) => {
  if (!n.rho || !n.rseed || !n.recipient) {
    throw new Error(
      `note ${n.nullifier} is missing rho/rseed/recipient - re-sync the wallet before voting`,
    );
  }
  return {
    commitment_hex: n.cmx,
    nullifier_hex: n.nullifier,
    value: Number(n.value),
    position: n.position,
    // raw orchard address = diversifier(11) || pk_d(32); diversifier is the
    // first 22 hex chars (see build_signed_spend_transaction's recipient_hex
    // consumer for the same 43-byte layout).
    diversifier_hex: n.recipient.slice(0, 22),
    rho_hex: n.rho,
    rseed_hex: n.rseed,
    // Orchard/ZIP-32 scope: 0 = external, 1 = internal (change).
    scope: n.is_change ? 1 : 0,
    ufvk_str: ufvkStr,
  };
};

/**
 * MISSING SUBSYSTEM: the round's note-commitment-tree root and nullifier-IMT
 * root are not served by the vote-servers' round-listing REST - they must be
 * computed locally by syncing both trees from the chain REST
 * (`/shielded-vote/v1/commitment-tree/{round}/leaves` and the nullifier IMT
 * equivalent), the way zcli's `vote-commitment-tree-client::http_sync_api::
 * HttpTreeSyncApi` does in the proven Rust round-trip
 * (crates/zcash-voting/tests/v09_cold_zigner_roundtrip.rs). zafu has no
 * TypeScript client for either tree yet. Fails closed (rather than sending
 * zeroed roots the wasm prover would reject anyway) until that sync client
 * exists.
 */
const resolveRoundCommitmentRoots = (
  round: VotingRound,
): { ncRootHex: string; nullifierImtRootHex: string } => {
  throw new Error(
    `round ${round.id}: cannot resolve the note-commitment-tree / nullifier-IMT roots - ` +
      'zafu has no vote-commitment-tree sync client yet (see resolveRoundCommitmentRoots)',
  );
};

/**
 * MISSING SUBSYSTEM: the VAN (vote-authorization-nullifier) merkle witness
 * and the delegation output's vote-commitment-tree position are produced by
 * the SAME missing sync client as resolveRoundCommitmentRoots - the position
 * is where the delegation's governance output landed in the tree, and the
 * witness is its auth path at cast time. Needed for `vote_json.vc_tree_
 * position` and `cast_vote_hot_wire`'s `van_witness_json`.
 */
const resolveVanWitness = (
  round: VotingRound,
): { vcTreePosition: number; authPathHex: string[]; anchorHeight: number } => {
  throw new Error(
    `round ${round.id}: cannot resolve the VAN witness / vote-commitment-tree position - ` +
      'zafu has no vote-commitment-tree sync client yet (see resolveVanWitness)',
  );
};

type VoteCastStep =
  | 'idle'
  | 'delegating-qr-sign'
  | 'scan-delegation'
  | 'delegated'
  | 'casting-proposal'
  | 'done';

interface CastProposalState {
  proposalId: number;
  selectedOptionId: number | null;
  submitting: boolean;
  error: string | null;
}

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
  const getMnemonic = useStore(selectGetMnemonic);
  const serverUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';

  const [step, setStep] = useState<VoteCastStep>('idle');
  const [delegateError, setDelegateError] = useState<string | null>(null);
  const [delegateSubmitting, setDelegateSubmitting] = useState(false);
  const [delegationRejection, setDelegationRejection] = useState<{
    status: number;
    message: string;
  } | null>(null);

  // Per-proposal state for vote casting
  const [proposalStates, setProposalStates] = useState<Record<number, CastProposalState>>(() =>
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
  const isDelegated =
    step !== 'idle' && step !== 'delegating-qr-sign' && step !== 'scan-delegation';

  // ─── Delegation Flow ───────────────────────────────────────────

  const handleStartDelegation = useCallback(async () => {
    setDelegateError(null);
    setDelegationRejection(null);
    setDelegateSubmitting(true);

    try {
      // ── gather the real crypto inputs ──

      const mnemonic = await getMnemonic(walletId);

      // fvk / seed fingerprint / account index for this wallet's (single)
      // orchard account. WalletKeys has no stored UFVK, so the worker
      // encodes + self-validates one from the raw FVK bytes (see
      // getOrchardAccountInfoInWorker).
      const { fvkHex, ufvkStr } = await getOrchardAccountInfoInWorker(mnemonic, VOTING_MAINNET);
      const seedFpHex = seedFingerprintHex(mnemonic);

      // hotkey: reuse the persisted one for this round if we already made
      // one (e.g. a retry after a failed submit), else generate + persist.
      const existingRound = await loadVotingRoundRecord(
        localExtStorage,
        sessionExtStorage,
        walletId,
        round.id,
      );
      const hotkeyPubkeyHex =
        existingRound?.hotkeyPubkeyHex ??
        (await (async () => {
          const hk = await generateVotingHotkeyInWorker(VOTING_WASM_NETWORK);
          await saveVotingHotkey(
            localExtStorage,
            sessionExtStorage,
            walletId,
            round.id,
            hk.hotkeySecretHex,
            hk.hotkeyPubkeyHex,
          );
          return hk.hotkeyPubkeyHex;
        })());

      // eligible notes at the snapshot height, from the worker's own note DB.
      const pool = notePoolForSnapshot(round.snapshotHeight);
      const poolNotes = await getPoolNotesInWorker('zcash', walletId);
      const eligible = eligibleNotesAtSnapshot(poolNotes[pool], round.snapshotHeight);
      if (eligible.length === 0) {
        throw new Error(
          `no unspent ${pool} notes at or below the round's snapshot height ` +
            `(${round.snapshotHeight}) - nothing to delegate`,
        );
      }
      const notesJson = JSON.stringify(eligible.map(n => toNoteInfoDto(n, ufvkStr)));

      // live consensus branch id (fail-closed if the endpoint can't answer,
      // same guard build-tx paths use - see fetchBranchIdHex).
      const { consensusBranchId } = await getConsensusBranchIdInWorker('zcash', serverUrl);

      // round params: ea_pk comes from the pinned dynamic config; the
      // note-commitment-tree root and nullifier-IMT root do not - see
      // resolveRoundCommitmentRoots for why (missing sync client).
      const roundEntry = config.rounds[round.id];
      if (!roundEntry) {
        throw new Error(`round ${round.id} is not in the pinned voting config (no ea_pk)`);
      }
      const { ncRootHex, nullifierImtRootHex } = resolveRoundCommitmentRoots(round);
      const roundParams = {
        vote_round_id: round.id,
        snapshot_height: round.snapshotHeight,
        ea_pk_hex: base64ToHex(roundEntry.ea_pk),
        nc_root_hex: ncRootHex,
        nullifier_imt_root_hex: nullifierImtRootHex,
      };
      const roundParamsJson = JSON.stringify(roundParams);

      const unsigned = await buildDelegationPcztInWorker({
        network: VOTING_WASM_NETWORK,
        fvkHex,
        seedFingerprintHex: seedFpHex,
        accountIndex: VOTING_ACCOUNT_INDEX,
        hotkeyPubkeyHex,
        notesJson,
        roundParamsJson,
        consensusBranchId,
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
        mainnet: VOTING_MAINNET,
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
  }, [walletId, round, config, getMnemonic, serverUrl]);

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

        // Merkle witnesses for the REAL delegated notes (dummy notes aren't
        // leaves in the note-commitment tree, so they have no witness - only
        // an IMT non-membership proof, fetched below). Order MUST match the
        // notes_json order build_delegation_pczt was called with;
        // real_note_nullifiers_hex preserves that order.
        const pool = notePoolForSnapshot(round.snapshotHeight);
        const { merkleWitnessesJson } = await getMerkleWitnessesInWorker('zcash', walletId, {
          nullifiers: ctx.realNoteNullifiersHex,
          targetHeight: round.snapshotHeight,
          serverUrl,
          pool,
        });

        // PIR-fetched IMT non-membership proofs, covering both the real and
        // dummy nullifiers (see finalize_delegation's docstring).
        const pirBaseUrl = config.pir_endpoints[0]?.url;
        if (!pirBaseUrl) {
          throw new Error('voting config has no pir_endpoints - cannot fetch IMT proofs');
        }
        const { imtProofsJson } = await pirFetchImtProofsInWorker({
          pirBaseUrl,
          nullifiersJson: JSON.stringify([
            ...ctx.realNoteNullifiersHex,
            ...ctx.dummyNoteNullifiersHex,
          ]),
        });

        // Phase 2 of 2: prove ZKP #1 with the host-fetched IMT proofs + witnesses
        // and attach the cold signer's spend-auth sig - submission wire.
        const wireResult = await finalizeDelegationInWorker({
          delegationContextJson: ctx.contextJson,
          merkleWitnessesJson,
          imtProofsJson,
          spendAuthSigHex,
          sighashHex: ctx.sighashHex,
        });

        // Submit delegation to vote servers
        const wireJson = wireResult.delegationSubmissionWireJson;
        const result = await submitDelegation(config, wireJson);

        if (result.ok) {
          // Persist the delegation state now - the cast flow needs it and
          // it's only ever produced here, once, by this successful finalize.
          await saveDelegationState(
            localExtStorage,
            sessionExtStorage,
            walletId,
            round.id,
            ctx.delegationStateJson,
          );
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
    [walletId, round, config, serverUrl, onDelegated],
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
        // ── gather the real crypto inputs ──

        const record = await loadVotingRoundRecord(
          localExtStorage,
          sessionExtStorage,
          walletId,
          round.id,
        );
        if (!record || !record.delegationStateJson) {
          throw new Error('no completed delegation found for this round - delegate first');
        }
        const hotkeySecretHex = record.hotkeySecretHex;
        const delegationStateJson = record.delegationStateJson;

        const roundEntry = config.rounds[round.id];
        if (!roundEntry) {
          throw new Error(`round ${round.id} is not in the pinned voting config (no ea_pk)`);
        }
        // cast_vote_hot_wire's round-params arg is the SMALLER shape (just
        // vote_round_id + ea_pk_hex) - it doesn't take snapshot_height or
        // the tree roots build_delegation_pczt's round params take.
        const roundParamsJson = JSON.stringify({
          vote_round_id: round.id,
          ea_pk_hex: base64ToHex(roundEntry.ea_pk),
        });

        const proposal = round.proposals.find(p => p.id === proposalId);
        if (!proposal) {
          throw new Error(`proposal ${proposalId} not found on round ${round.id}`);
        }
        // Same missing vote-commitment-tree sync client as delegation - the
        // VAN witness and the delegation output's tree position (vc_tree_
        // position, below) both come from syncing that tree at cast time.
        const { vcTreePosition, authPathHex, anchorHeight } = resolveVanWitness(round);
        const vanWitnessJson = JSON.stringify({
          auth_path_hex: authPathHex,
          position: vcTreePosition,
          anchor_height: anchorHeight,
        });
        const voteJson = JSON.stringify({
          proposal_id: proposalId,
          choice: proposalState.selectedOptionId,
          num_options: proposal.options.length,
          vc_tree_position: vcTreePosition,
          single_share: true,
        });

        // Build the hot (non-QR) vote commitment PCZT
        const voteResult = await castVoteHotInWorker({
          network: VOTING_WASM_NETWORK,
          hotkeySecretHex,
          roundParamsJson,
          delegationStateJson,
          vanWitnessJson,
          voteJson,
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
              <div className='text-label text-fg-high font-medium'>
                sign delegation with zafu zigner
              </div>

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
                <div className='text-label text-fg-high'>
                  {proposal.title || `proposal ${proposal.id}`}
                </div>

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
                    disabled={pState.selectedOptionId === null || pState.submitting || !isDelegated}
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
