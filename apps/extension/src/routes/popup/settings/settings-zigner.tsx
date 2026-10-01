import { EyeOpenIcon, TrashIcon } from '@radix-ui/react-icons';
import { useStore } from '../../../state';
import { keyRingSelector } from '../../../state/keyring';
import { SettingsScreen } from './settings-screen';
import { Button } from '@repo/ui/components/ui/button';
import { useState } from 'react';
import { PagePath } from '../../page/paths';
import { openPageInTab } from '../../../utils/popup-detection';

/** network color for zigner vault badges */
const networkColors: Record<string, string> = {
  penumbra: 'text-purple-500',
  zcash: 'text-yellow-500',
  cosmos: 'text-pink-500',
  noble: 'text-pink-500',
  cosmoshub: 'text-indigo-500',
};

/**
 * Settings page for zigner cold wallet integration: lists paired vaults and
 * links out to the shared scanner (components/device-scanner, opened as its
 * own page - better camera access than a popup gets). Pairing itself does
 * not live here.
 */
export const SettingsZigner = () => {
  const { keyInfos, deleteKeyRing } = useStore(keyRingSelector);
  const [deletingVaultId, setDeletingVaultId] = useState<string | null>(null);
  const [confirmDeleteVault, setConfirmDeleteVault] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // All zigner vaults from the keyring (single source of truth)
  const zignerVaults = keyInfos.filter(k => k.type === 'zigner-zafu');

  const handleDeleteVault = async (vaultId: string) => {
    try {
      setDeletingVaultId(vaultId);
      await deleteKeyRing(vaultId);
      setConfirmDeleteVault(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`failed to remove wallet: ${message}`);
    } finally {
      setDeletingVaultId(null);
    }
  };

  return (
    <SettingsScreen title='zafu zigner'>
      <div className='flex flex-col gap-4'>
        {/* Info Box */}
        <div className='border border-border-soft bg-elev-1 p-4'>
          <p className='text-xs text-fg'>cold wallet - keeps spending keys offline, sign by QR.</p>
        </div>

        {/* Cold-signing value prop, shown when no zigner is paired yet - markets
            the air-gapped signer itself (security), not a subscription. */}
        {zignerVaults.length === 0 && (
          <div className='border border-zigner-gold/30 bg-zigner-gold/5 p-4 flex flex-col gap-3'>
            <div className='flex items-start gap-3'>
              <span className='i-ph-shield-check size-5 text-zigner-gold shrink-0 mt-0.5' />
              <div className='flex flex-col gap-2'>
                <p className='text-data text-fg-high lowercase'>keep your keys off this device</p>
                <p className='text-xs text-fg-muted'>
                  pair a zigner air-gapped signer - your spending keys never touch a networked
                  device, and you approve each transaction by scanning a QR.
                </p>
              </div>
            </div>
            <div className='flex gap-2'>
              <Button
                size='sm'
                onClick={() => openPageInTab(PagePath.IMPORT_SIGNER)}
                title='scan the pairing QR from your zigner'
              >
                pair zigner
              </Button>
              <Button
                variant='secondary'
                size='sm'
                onClick={() =>
                  window.open('https://zafu.pro/zigner', '_blank', 'noopener,noreferrer')
                }
              >
                get zigner
              </Button>
            </div>
          </div>
        )}

        {/* Zigner Wallets - unified list from keyring (visible to all users) */}
        {zignerVaults.length > 0 && (
          <div className='border-t border-border-soft pt-4'>
            <div className='mb-3 flex items-center justify-between'>
              <p className='kicker'>wallets</p>
              <button
                type='button'
                onClick={() => openPageInTab(PagePath.IMPORT_SIGNER)}
                className='text-label text-zigner-gold hover:underline underline-offset-2 lowercase'
                title='scan the pairing QR from another zigner'
              >
                + pair another
              </button>
            </div>
            <div className='flex flex-col gap-2'>
              {zignerVaults.map(vault => {
                const networks =
                  (vault.insensitive['supportedNetworks'] as string[] | undefined) ?? [];
                const primaryNetwork = networks[0] ?? 'unknown';
                const colorClass = networkColors[primaryNetwork] ?? 'text-fg-muted';
                const cosmosAddrs = vault.insensitive['cosmosAddresses'] as
                  | { chainId: string; address: string; prefix: string }[]
                  | undefined;

                return (
                  <div
                    key={vault.id}
                    className='flex items-center justify-between border border-border-soft bg-elev-1 p-3'
                  >
                    <div className='flex flex-col gap-2 min-w-0'>
                      <div className='flex items-center gap-2'>
                        <EyeOpenIcon className={`size-4 ${colorClass} flex-shrink-0`} />
                        <span className='text-data text-fg-high truncate'>{vault.name}</span>
                        {networks.map(n => (
                          <span key={n} className='text-label px-1 bg-elev-2 text-fg-dim lowercase'>
                            {n}
                          </span>
                        ))}
                      </div>
                      {cosmosAddrs?.map(a => (
                        <span key={a.chainId} className='text-label tabular text-fg-muted pl-6'>
                          {a.chainId}: {a.address.slice(0, 10)}...{a.address.slice(-6)}
                        </span>
                      ))}
                    </div>

                    {confirmDeleteVault === vault.id ? (
                      <div className='flex items-center gap-2'>
                        <Button
                          variant='danger'
                          size='sm'
                          onClick={() => void handleDeleteVault(vault.id)}
                          disabled={deletingVaultId === vault.id}
                        >
                          {deletingVaultId === vault.id ? 'removing...' : 'confirm'}
                        </Button>
                        <Button
                          variant='secondary'
                          size='sm'
                          onClick={() => setConfirmDeleteVault(null)}
                          disabled={deletingVaultId === vault.id}
                        >
                          cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant='quiet'
                        size='sm'
                        onClick={() => setConfirmDeleteVault(vault.id)}
                        disabled={keyInfos.length <= 1}
                        title={
                          keyInfos.length <= 1 ? 'cannot remove the last wallet' : 'remove wallet'
                        }
                      >
                        <TrashIcon className='size-4 text-fg-muted hover:text-red-400' />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {error && <p className='text-xs text-red-400'>{error}</p>}
      </div>
    </SettingsScreen>
  );
};
