import { GrpcEndpointForm } from '../../../shared/components/grpc-endpoint-form';
import { SettingsScreen } from './settings-screen';

export const SettingsRPC = () => {
  const onSuccess = () => {
    chrome.runtime.reload();
  };

  return (
    <SettingsScreen title='network provider'>
      <GrpcEndpointForm submitButtonLabel={'Save'} isOnboarding={false} onSuccess={onSuccess} />
    </SettingsScreen>
  );
};
