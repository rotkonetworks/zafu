import { SettingsScreen } from './settings-screen';
import { DefaultFrontendForm } from '../../../shared/components/default-frontend-form';

export const SettingsDefaultFrontend = () => {
  return (
    <SettingsScreen title='default frontend'>
      <DefaultFrontendForm />
    </SettingsScreen>
  );
};
