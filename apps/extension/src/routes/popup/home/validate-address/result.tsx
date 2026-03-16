import type { AddressOwnershipInfo } from './types';

export const Result = ({
  addressOwnershipInfo,
}: {
  addressOwnershipInfo?: AddressOwnershipInfo;
}) => {
  if (!addressOwnershipInfo) {
    return null;
  }

  if (!addressOwnershipInfo.isValidAddress) {
    return (
      <div className='flex items-center gap-2'>
        <span className='i-lucide-badge-alert text-red' />
        Invalid address
      </div>
    );
  }

  if (addressOwnershipInfo.belongsToWallet) {
    return (
      <div className='flex items-center gap-2'>
        <span className='i-lucide-badge-check text-green' />

        <div className='flex flex-col'>
          Belongs to this wallet
          <span className='text-xs text-muted-foreground'>
            {addressOwnershipInfo.addressIndexAccount === 0
              ? 'Main Account'
              : `Sub-Account #${addressOwnershipInfo.addressIndexAccount}`}
            {addressOwnershipInfo.isEphemeral && (
              <>
                {' '}
                &bull; <span className='text-rust'>IBC deposit address</span>
              </>
            )}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className='flex items-center gap-2'>
      <span className='i-lucide-badge-alert text-red' />
      Does not belong to this wallet
    </div>
  );
};
