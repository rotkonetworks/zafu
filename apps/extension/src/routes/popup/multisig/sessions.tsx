/**
 * multisig tab - FROST threshold wallet management
 *
 * lists multisig wallets with threshold badges and balances.
 * quick actions for create, join, and co-sign flows.
 * status indicators for active DKG/signing sessions.
 */

import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import {
  selectZcashWallets,
  selectVisibleMultisigWallets,
  walletsSelector,
  type ZcashWalletJson,
} from '../../../state/wallets';
import { selectActiveNetwork, selectEffectiveKeyInfo, keyRingSelector } from '../../../state/keyring';
import { frostDkgSelector, frostSigningSelector } from '../../../state/frost-session';
import { getBalanceInWorker } from '../../../state/keyring/network-worker';
import { useZcashSyncStatus } from '../../../hooks/zcash-sync';
import { NetworkUnavailable } from '../../../shared/components/network-unavailable';
import { usePasswordGate } from '../../../hooks/password-gate';
import { cn } from '@repo/ui/lib/utils';
import { PopupPath } from '../paths';
import { BackupModal } from './backup/backup-modal';
import { exportSingleBackup } from './backup/export-helpers';
import { applyTableFilter, type TableView, type TableFilter } from '../../../state/app-managed-tables';
import { useAppManagedTables } from '../../../hooks/app-managed-tables';

/** format zatoshi to ZEC display string */
const formatZec = (zat: bigint) => {
  const whole = zat / 100_000_000n;
  const frac = zat % 100_000_000n;
  const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracStr}`;
};

/** truncate address for display */
const truncateAddr = (addr: string) =>
  addr.length > 16 ? `${addr.slice(0, 8)}...${addr.slice(-8)}` : addr;

/** session status indicator */
const SessionBadge = () => {
  const dkg = useStore(frostDkgSelector);
  const signing = useStore(frostSigningSelector);

  if (!dkg && !signing) {
    return null;
  }

  const label = dkg ? `DKG round ${dkg.round}` : `signing - ${signing!.step}`;

  return (
    <div className='flex items-center gap-1.5 rounded-md bg-yellow-500/10 px-2.5 py-1.5 text-xs text-yellow-400'>
      <span className='h-2 w-2 rounded-full bg-yellow-400 animate-pulse' />
      {label}
    </div>
  );
};

/** single wallet row */
const WalletRow = ({
  wallet,
  balance,
  isActive,
  onSelect,
  onEdit,
  onBackup,
}: {
  wallet: ZcashWalletJson & { originalIndex: number };
  balance: bigint;
  isActive: boolean;
  onSelect: () => void;
  onEdit: () => void;
  /** present only for self-custody multisig — airgap shows nothing here. */
  onBackup?: () => void;
}) => (
  <div
    className={cn(
      'flex items-center w-full rounded-lg px-3 py-3 transition-colors',
      isActive ? 'bg-primary/10 ring-1 ring-primary/20' : 'hover:bg-elev-1',
    )}
  >
    <button
      onClick={onSelect}
      className='flex flex-1 items-center justify-between min-w-0 text-left'
    >
      <div className='flex flex-col gap-1 min-w-0'>
        <div className='flex items-center gap-2'>
          <span className='rounded bg-primary/15 px-1.5 py-0.5 text-label font-semibold text-zigner-gold leading-none shrink-0'>
            {wallet.multisig!.threshold}-of-{wallet.multisig!.maxSigners}
          </span>
          <span className='text-sm font-medium truncate'>{wallet.label}</span>
          {isActive && <span className='i-lucide-check h-3 w-3 text-zigner-gold shrink-0' />}
        </div>
        <span className='text-body text-fg-muted font-mono'>{truncateAddr(wallet.address)}</span>
        {wallet.multisig?.zignerWalletId && (
          <span className='text-label text-fg-dim font-mono'>
            zigner: {wallet.multisig.zignerWalletId}
          </span>
        )}
      </div>
      <span className='text-sm font-mono text-fg-muted shrink-0 ml-2'>
        {formatZec(balance)} ZEC
      </span>
    </button>
    {onBackup && (
      <button
        onClick={onBackup}
        className='ml-1 p-1.5 rounded-md text-fg-muted hover:text-fg-high hover:bg-elev-1 transition-colors shrink-0'
        title='backup wallet'
      >
        <span className='i-lucide-download h-3.5 w-3.5' />
      </button>
    )}
    <button
      onClick={onEdit}
      className='ml-1 p-1.5 rounded-md text-fg-muted hover:text-fg-high hover:bg-elev-1 transition-colors shrink-0'
      title='wallet settings'
    >
      <span className='i-lucide-settings h-3.5 w-3.5' />
    </button>
  </div>
);

// ── app-managed (poker) tables manager ──────────────────────────────────────
// Thin renderer over state/app-managed-tables.ts. Deleting a hidden table is ALWAYS the guarded
// path (heavy warning + typed intent + backup-first): getMultisigStatus can't PROVE a hidden table
// is empty (only the active wallet syncs, and getBalance ignores mempool), so a low-friction delete
// can't be made sound — we don't offer one. Recover first (which syncs it) if you want to verify.

const tableStatusLine = (t: TableView): { text: string; tone: string } => {
  if (t.balanceZat > 0n) {return { text: `holds ${formatZec(t.balanceZat)} ZEC`, tone: 'text-zigner-gold' };}
  if (!t.synced) {return { text: 'not synced', tone: 'text-yellow-400/80' };}
  return { text: 'settled — empty', tone: 'text-fg-muted' };
};

const GuardedDeleteModal = (props: {
  row: TableView;
  onBackup: () => void;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) => {
  const label = props.row.wallet.label;
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed === label || typed.trim().toUpperCase() === 'DELETE';

  const confirm = async () => {
    if (!matches || working) {return;}
    setWorking(true);
    setError(null);
    try {
      await props.onConfirm();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete failed');
      setWorking(false);
    }
  };

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4'>
      <div className='w-full max-w-sm rounded-lg border border-red-500/30 bg-elev-1 p-4'>
        <h2 className='text-base font-medium text-red-400'>delete "{label}"?</h2>
        <div className='mt-3 rounded-md border border-red-500/40 bg-red-500/5 p-2 text-label text-red-300'>
          <span className='i-lucide-alert-triangle mr-1 inline-block size-3 align-text-bottom' />
          You will permanently lose access to any funds in this table — it is NOT recoverable from
          your seed. If other co-signers rely on your share to reach the signing threshold, they may
          be unable to move funds either.
        </div>
        <button
          onClick={props.onBackup}
          className='mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border-soft px-3 py-2 text-xs text-fg-muted transition-colors hover:bg-elev-2'
        >
          <span className='i-lucide-download h-3.5 w-3.5' />
          Export backup first
        </button>
        <label className='mt-3 block text-xs text-fg-muted'>
          type <span className='font-mono text-fg'>{label}</span> (or{' '}
          <span className='font-mono text-fg'>DELETE</span>) to confirm
          <input
            type='text'
            autoFocus
            autoComplete='off'
            value={typed}
            onChange={e => setTyped(e.target.value)}
            className='mt-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2 font-mono text-sm focus:border-red-500/50 focus:outline-none'
            placeholder={label}
          />
        </label>
        {error && (
          <p className='mt-2 rounded-md border border-red-500/40 bg-red-500/5 p-2 text-body text-red-400'>
            {error}
          </p>
        )}
        <div className='mt-4 flex gap-2'>
          <button
            onClick={props.onClose}
            disabled={working}
            className='flex-1 rounded-lg border border-border-soft py-2 text-xs transition-colors hover:bg-elev-2 disabled:opacity-50'
          >
            cancel
          </button>
          <button
            onClick={() => void confirm()}
            disabled={!matches || working}
            className='flex-1 rounded-lg border border-red-500/40 bg-red-500/15 py-2 text-xs text-red-400 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-40'
          >
            {working ? 'deleting…' : 'delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
};

const AppManagedRow = (props: {
  row: TableView;
  onRecover: () => void;
  onBackup: () => void;
  onDelete: () => void;
}) => {
  const status = tableStatusLine(props.row);
  const created = props.row.createdAt
    ? new Date(props.row.createdAt).toLocaleDateString()
    : 'unknown';
  return (
    <div className='flex flex-col gap-2 rounded-lg border border-border-soft bg-elev-1 px-3 py-3'>
      <div className='flex min-w-0 items-center justify-between gap-2'>
        <div className='flex min-w-0 flex-col gap-0.5'>
          <span className='truncate text-sm font-medium'>{props.row.wallet.label}</span>
          <span className='text-label text-fg-dim'>created {created}</span>
        </div>
        <span className={cn('shrink-0 font-mono text-xs', status.tone)}>{status.text}</span>
      </div>
      <div className='flex gap-2'>
        <button
          onClick={props.onRecover}
          className='flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border-soft px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-elev-2 hover:text-zigner-gold'
          title='make this a normal, selectable multisig you can co-sign'
        >
          <span className='i-lucide-arrow-up-right h-3.5 w-3.5' />
          Recover
        </button>
        <button
          onClick={props.onBackup}
          className='flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border-soft px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-elev-2 hover:text-fg'
          title='export this share as an encrypted backup file'
        >
          <span className='i-lucide-download h-3.5 w-3.5' />
          Back up
        </button>
        <button
          onClick={props.onDelete}
          className='flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-red-500/30 px-2 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-500/10'
          title='delete this table'
        >
          <span className='i-lucide-trash-2 h-3.5 w-3.5' />
          Delete
        </button>
      </div>
    </div>
  );
};

const AppManagedTablesSection = () => {
  const tables = useAppManagedTables();
  const { setMultisigHidden, deleteKeyRing } = useStore(keyRingSelector);
  const { requestAuth, PasswordModal } = usePasswordGate();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<TableFilter>({});
  const [backupTarget, setBackupTarget] = useState<TableView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TableView | null>(null);

  const visible = useMemo(() => applyTableFilter(tables, filter, Date.now()), [tables, filter]);

  if (tables.length === 0) {return null;}

  const openBackup = async (row: TableView) => {
    if (await requestAuth()) {setBackupTarget(row);}
  };

  return (
    <div className='mt-3 rounded-lg border border-border-soft'>
      {PasswordModal}
      <BackupModal
        open={backupTarget !== null}
        title={backupTarget ? `export "${backupTarget.wallet.label}"` : ''}
        walletLabel={backupTarget?.wallet.label ?? ''}
        onConfirm={async passphrase => {
          if (backupTarget) {await exportSingleBackup(backupTarget.wallet, passphrase);}
        }}
        onClose={() => setBackupTarget(null)}
      />
      {deleteTarget && (
        <GuardedDeleteModal
          row={deleteTarget}
          onBackup={() => void openBackup(deleteTarget)}
          onConfirm={() => deleteKeyRing(deleteTarget.wallet.vaultId, { allowAppManaged: true })}
          onClose={() => setDeleteTarget(null)}
        />
      )}
      <button
        onClick={() => setExpanded(e => !e)}
        className='flex w-full items-center justify-between px-3 py-2.5 text-left'
      >
        <span className='flex items-center gap-2'>
          <span className='i-lucide-layout-grid h-4 w-4 text-fg-muted' />
          <span className='text-sm font-medium'>App-managed tables</span>
          <span className='rounded bg-elev-2 px-1.5 py-0.5 text-label font-mono text-fg-muted'>
            {tables.length}
          </span>
        </span>
        <span
          className={cn(
            'i-lucide-chevron-down h-4 w-4 text-fg-muted transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>
      {expanded && (
        <div className='flex flex-col gap-3 border-t border-border-soft p-3'>
          <p className='text-label text-fg-dim'>
            Tables created by apps (e.g. poker). Hidden from your main wallet. Recover to co-sign by
            hand; delete only once you're sure it's settled.
          </p>
          <input
            type='text'
            value={filter.query ?? ''}
            onChange={e => setFilter(f => ({ ...f, query: e.target.value }))}
            placeholder='search tables…'
            className='w-full rounded-lg border border-border-soft bg-input px-3 py-2 text-sm focus:border-primary/50 focus:outline-none'
          />
          <div className='flex flex-wrap gap-x-4 gap-y-2'>
            <label className='flex cursor-pointer select-none items-center gap-1.5 text-xs text-fg-muted'>
              <input
                type='checkbox'
                checked={filter.onlyFunded ?? false}
                onChange={e => setFilter(f => ({ ...f, onlyFunded: e.target.checked }))}
              />
              funded only
            </label>
            <label className='flex cursor-pointer select-none items-center gap-1.5 text-xs text-fg-muted'>
              <input
                type='checkbox'
                checked={filter.showAll ?? false}
                onChange={e => setFilter(f => ({ ...f, showAll: e.target.checked }))}
              />
              show all
            </label>
          </div>
          {visible.length > 0 ? (
            <div className='flex flex-col gap-2'>
              {visible.map(row => (
                <AppManagedRow
                  key={row.wallet.id}
                  row={row}
                  onRecover={() => void setMultisigHidden(row.wallet.vaultId, false)}
                  onBackup={() => void openBackup(row)}
                  onDelete={() => setDeleteTarget(row)}
                />
              ))}
            </div>
          ) : (
            <p className='py-3 text-center text-xs text-fg-muted'>No tables match this filter.</p>
          )}
        </div>
      )}
    </div>
  );
};

export const MultisigPage = () => {
  const navigate = useNavigate();
  const activeNetwork = useStore(selectActiveNetwork);
  const zcashWallets = useStore(selectZcashWallets);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const multisigWallets = useStore(selectVisibleMultisigWallets);
  const { setActiveZcashWallet } = useStore(walletsSelector);
  const { workerSyncHeight } = useZcashSyncStatus();
  const [balances, setBalances] = useState<Record<string, bigint>>({});

  // per-wallet backup UI state. restore is on the settings backup page.
  const [backupTarget, setBackupTarget] = useState<ZcashWalletJson | null>(null);
  const { requestAuth, PasswordModal } = usePasswordGate();

  // multisig is zcash-only; placeholder elsewhere. Computed early but
  // applied as an early-return only after every hook below has run, so
  // the hook count stays stable across network switches.
  const isZcash = activeNetwork === 'zcash';

  const walletsWithIndex = useMemo(
    () =>
      multisigWallets.map(w => ({
        ...w,
        originalIndex: zcashWallets.indexOf(w),
      })),
    [multisigWallets, zcashWallets],
  );

  // fetch balances for all multisig wallets. sync writes notes keyed by
  // vaultId (selectedKeyInfo.id), not zcashWallet.id, so the balance lookup
  // must use vaultId; local state stays keyed by w.id for row identity.
  // re-fetch on every sync-progress tick so the active vault's row stays
  // in step with the home-page balance. skip entirely when off zcash —
  // gate inside the effect, not around it (Rules of Hooks).
  useEffect(() => {
    if (!isZcash) {
      return;
    }
    const fetchAll = () => {
      for (const w of walletsWithIndex) {
        if (!w.vaultId) {
          continue;
        }
        const vaultId = w.vaultId;
        const rowId = w.id;
        getBalanceInWorker('zcash', vaultId)
          .then(bal => setBalances(prev => ({ ...prev, [rowId]: BigInt(bal) })))
          .catch(() => {});
      }
    };
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.network !== 'zcash') {
        return;
      }
      fetchAll();
    };
    window.addEventListener('network-sync-progress', handler);
    fetchAll();
    return () => window.removeEventListener('network-sync-progress', handler);
  }, [walletsWithIndex, workerSyncHeight, isZcash]);

  const totalZat = Object.values(balances).reduce((sum, b) => sum + b, 0n);

  // operate-mode: gate on the selected vault, not activeZcashIndex — the
  // index lags on switches to mnemonic (which has no zcash wallet record),
  // so the index can still point at a multisig vault while the user is on
  // a mnemonic. selectedKeyInfo.type is the source of truth.
  const activeMs =
    selectedKeyInfo?.type === 'frost-multisig'
      ? walletsWithIndex.find(w => w.vaultId === selectedKeyInfo.id)
      : undefined;

  // route to zigner-airgap flows when the user is signing through a zigner —
  // either the active multisig is airgap, or the active single-sig is zigner-imported.
  const useAirgap =
    activeMs?.multisig?.custody === 'airgapSigner' || selectedKeyInfo?.type === 'zigner-zafu';
  // Route surface is unified: one /multisig/create and one /multisig/join.
  // The flow dispatches internally on `?mode=zigner` OR on the active
  // wallet being zigner-imported.
  const createPath = useAirgap
    ? (`${PopupPath.MULTISIG_CREATE}?mode=zigner` as PopupPath)
    : PopupPath.MULTISIG_CREATE;
  const joinPath = useAirgap
    ? (`${PopupPath.MULTISIG_JOIN}?mode=zigner` as PopupPath)
    : PopupPath.MULTISIG_JOIN;

  if (!isZcash) {
    return <NetworkUnavailable feature='multisig' iconClass='i-lucide-shield' />;
  }

  return (
    <div className='flex flex-col gap-3 p-4'>
      {PasswordModal}
      <BackupModal
        open={backupTarget !== null}
        title={backupTarget ? `export "${backupTarget.label}"` : ''}
        walletLabel={backupTarget?.label ?? ''}
        onConfirm={async passphrase => {
          if (backupTarget) {
            await exportSingleBackup(backupTarget, passphrase);
          }
        }}
        onClose={() => setBackupTarget(null)}
      />
      {/* header */}
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <span className='i-lucide-shield h-5 w-5 text-zigner-gold' />
          <h2 className='text-base font-semibold'>Multisig</h2>
        </div>
        {walletsWithIndex.length > 0 && (
          <span className='text-sm font-mono text-fg-muted'>{formatZec(totalZat)} ZEC</span>
        )}
      </div>

      {/* active session indicator */}
      <SessionBadge />

      {activeMs ? (
        // operate mode — active vault is multisig
        <>
          {/* primary CTA: co-sign */}
          <button
            onClick={() => navigate(PopupPath.MULTISIG_SIGN)}
            className='flex items-center justify-center gap-2 rounded-lg bg-primary/15 px-4 py-4 text-base font-semibold text-zigner-gold transition-colors hover:bg-primary/25'
          >
            <span className='i-lucide-pen-tool h-5 w-5' />
            Co-sign transaction
          </button>

          {/* active vault card */}
          <WalletRow
            key={activeMs.id}
            wallet={activeMs}
            balance={balances[activeMs.id] ?? 0n}
            isActive
            onSelect={() => {}}
            onEdit={() => navigate(`${PopupPath.SETTINGS_MULTISIG}?id=${activeMs.id}`)}
            onBackup={
              activeMs.multisig?.custody === 'airgapSigner'
                ? undefined
                : async () => {
                    if (await requestAuth()) {
                      setBackupTarget(activeMs);
                    }
                  }
            }
          />

          {/* secondary actions: small icon-buttons in a footer */}
          <div className='flex items-center justify-center gap-4 pt-1'>
            <button
              onClick={() => navigate(createPath)}
              className='flex items-center gap-1.5 text-xs text-fg-muted transition-colors hover:text-zigner-gold'
            >
              <span className='i-lucide-plus h-3.5 w-3.5' />
              New vault
            </button>
            <span className='h-3 w-px bg-border-soft' />
            <button
              onClick={() => navigate(joinPath)}
              className='flex items-center gap-1.5 text-xs text-fg-muted transition-colors hover:text-zigner-gold'
            >
              <span className='i-lucide-user-plus h-3.5 w-3.5' />
              Join existing
            </button>
          </div>
        </>
      ) : (
        // overview mode — active wallet is not multisig (or none exist)
        <>
          {walletsWithIndex.length > 0 ? (
            <div className='flex flex-col gap-1.5'>
              {walletsWithIndex.map(w => (
                <WalletRow
                  key={w.id}
                  wallet={w}
                  balance={balances[w.id] ?? 0n}
                  isActive={w.vaultId === selectedKeyInfo?.id}
                  onSelect={() => void setActiveZcashWallet(w.originalIndex)}
                  onEdit={() => navigate(`${PopupPath.SETTINGS_MULTISIG}?id=${w.id}`)}
                  onBackup={
                    w.multisig?.custody === 'airgapSigner'
                      ? undefined
                      : async () => {
                          if (await requestAuth()) {
                            setBackupTarget(w);
                          }
                        }
                  }
                />
              ))}
            </div>
          ) : (
            <div className='flex flex-col items-center gap-2 py-8 text-center text-fg-muted'>
              <span className='i-lucide-shield-off h-8 w-8 opacity-50' />
              <p className='text-sm'>No multisig wallets yet</p>
            </div>
          )}

          <div className='flex flex-col gap-2 pt-2'>
            <div className='flex gap-2'>
              <button
                onClick={() => navigate(createPath)}
                className='flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2.5 text-sm font-medium text-zigner-gold transition-colors hover:bg-primary/20'
              >
                <span className='i-lucide-plus h-4 w-4' />
                Create
              </button>
              <button
                onClick={() => navigate(joinPath)}
                className='flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2.5 text-sm font-medium text-zigner-gold transition-colors hover:bg-primary/20'
              >
                <span className='i-lucide-user-plus h-4 w-4' />
                Join
              </button>
            </div>
            {walletsWithIndex.length > 0 && (
              <button
                onClick={() => navigate(PopupPath.MULTISIG_SIGN)}
                className='flex items-center justify-center gap-1.5 rounded-lg border border-border-soft px-3 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-elev-1'
              >
                <span className='i-lucide-pen-tool h-4 w-4' />
                Co-sign transaction
              </button>
            )}
            <button
              onClick={() => navigate(PopupPath.SETTINGS_MULTISIG_BACKUP)}
              className='flex items-center justify-center gap-1.5 rounded-lg border border-border-soft px-3 py-2 text-xs text-fg-muted transition-colors hover:bg-elev-1'
            >
              <span className='i-lucide-upload h-3.5 w-3.5' />
              Restore backup / Import from zigner
            </button>
          </div>
        </>
      )}

      {isZcash && <AppManagedTablesSection />}
    </div>
  );
};
