import { Row } from '@repo/ui/components/ui/row';
import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { usePopupNav } from '../../../utils/navigate';
import {
  useZcashMeMode,
  ZCASHME_MODE_LABEL,
  type ZcashMeMode,
} from '../../../services/zcashme/config';
import { PopupPath } from '../paths';
import { Section, SettingsScreen } from './settings-screen';
import { useExplain } from './settings-explain';
import { saveDiscovery, useDiscoveryOn } from './relay-rows';

/** who sees what, for each zcash.me mode */
const ZCASHME_SEES: Record<ZcashMeMode, string> = {
  off: 'nothing leaves zafu for it',
  directory: 'zcash.me sees one download, not who you look up',
  live: 'zcash.me sees each name you look up',
};

/** zcash.me - its own screen owns the mode picker (settings-zcashme.tsx) */
export const ZcashMeRow = ({ onExplain }: { onExplain?: (label: string) => void }) => {
  const navigate = usePopupNav();
  const mode = useZcashMeMode() ?? 'off';
  return (
    <Row
      type='value'
      label='zcash.me names'
      description={ZCASHME_SEES[mode]}
      value={ZCASHME_MODE_LABEL[mode]}
      preload={PopupPath.SETTINGS_ZCASHME}
      onPress={() => navigate(PopupPath.SETTINGS_ZCASHME)}
      onExplain={onExplain}
    />
  );
};

/** contact discovery: its relay lives under network */
export const ContactDiscoveryRow = ({ onExplain }: { onExplain?: (label: string) => void }) => {
  const on = useDiscoveryOn();
  return on === undefined ? null : (
    <Row
      type='toggle'
      label='contact discovery'
      description='the relay sees a sealed sign, your ip and when'
      checked={on}
      onChange={enabled => void saveDiscovery({ enabled })}
      onExplain={onExplain}
    />
  );
};

/** people: who can find you (SetPeople.dc.html) */
export const SettingsPeople = () => {
  const identity = useStore(s => s.privacy.settings.enableIdentity);
  const setSetting = useStore(s => s.privacy.setSetting);
  const zcashOn = useStore(s => selectEnabledNetworks(s).includes('zcash'));
  const { explainProps, sheet } = useExplain();
  return (
    <SettingsScreen title='people' category='people' home backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4'>
        <Section title='you'>
          <Row
            type='toggle'
            label='zid identity'
            description='a site you approve sees a zid made for it'
            checked={identity}
            onChange={v => void setSetting('enableIdentity', v)}
            {...explainProps('privacy.zidIdentity')}
          />
        </Section>
        {(identity || zcashOn) && (
          <Section title='finding and being found'>
            {/* discovery derives from the zid contact layer; hidden while zid is off */}
            {identity && <ContactDiscoveryRow {...explainProps('privacy.contactDiscovery')} />}
            {zcashOn && <ZcashMeRow {...explainProps('privacy.zcashMe')} />}
          </Section>
        )}
      </div>
      {sheet}
    </SettingsScreen>
  );
};
