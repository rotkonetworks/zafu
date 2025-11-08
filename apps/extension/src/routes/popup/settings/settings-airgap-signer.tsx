import { CameraIcon } from '@radix-ui/react-icons';
import { useStore } from '../../../state';
import { airgapSignerSelector } from '../../../state/airgap-signer';
import { SettingsScreen } from './settings-screen';
import { Switch } from '@repo/ui/components/ui/switch';

export const SettingsAirgapSigner = () => {
  const { cameraEnabled, setCameraEnabled } = useStore(airgapSignerSelector);

  return (
    <SettingsScreen title='Airgap Signing' IconComponent={() => <CameraIcon className='size-5' />}>
      <div className='flex flex-col gap-4'>
        <div className='flex items-center justify-between'>
          <div className='flex flex-col gap-1'>
            <p className='text-base font-bold'>QR Camera Access</p>
            <p className='text-sm text-muted-foreground'>
              Enable camera to scan QR codes for airgapped wallet signing
            </p>
          </div>
          <Switch checked={cameraEnabled} onCheckedChange={setCameraEnabled} />
        </div>

        <div className='mt-4 rounded-lg border border-border bg-card-radial p-4'>
          <p className='text-sm text-muted-foreground'>
            When enabled, Prax can use your device camera to scan transaction signatures from an
            airgapped device like Parity Signer. Your transactions are signed offline for maximum
            security.
          </p>
        </div>
      </div>
    </SettingsScreen>
  );
};
