import { Row } from '@repo/ui/components/ui/row';
import { useStore } from '../../../state';
import { PopupPath } from '../paths';
import { Section, SettingsScreen } from './settings-screen';
import { FontRow, ThemeRow } from './settings-appearance';
import { useExplain } from './settings-explain';

/** display: what this screen shows and sounds, to you and to whoever stands nearby (SetDisplay.dc.html) */
export const SettingsDisplay = () => {
  const hidden = useStore(s => s.privacy.settings.hideBalances);
  const soundMessages = useStore(s => s.privacy.settings.soundMessages);
  const soundMoney = useStore(s => s.privacy.settings.soundMoney);
  const setSetting = useStore(s => s.privacy.setSetting);
  const { explainProps, sheet } = useExplain();
  return (
    <SettingsScreen title='display' category='display' home backPath={PopupPath.SETTINGS}>
      <Section>
        <Row
          type='toggle'
          label='hide balances'
          description='when on, anyone nearby sees shapes, not numbers'
          checked={hidden}
          onChange={v => void setSetting('hideBalances', v)}
          {...explainProps('privacy.hideBalances')}
        />
        <ThemeRow
          description='sumi is dark, washi is light'
          {...explainProps('appearance.theme')}
        />
        <FontRow
          description='bundled with zafu · no font is fetched'
          {...explainProps('appearance.font')}
        />
      </Section>
      <Section>
        <Row
          type='toggle'
          label='sound for messages'
          description='a small bell while zafu is open · anyone nearby hears it'
          checked={soundMessages}
          onChange={v => void setSetting('soundMessages', v)}
          {...explainProps('privacy.soundMessages')}
        />
        <Row
          type='toggle'
          label='sound for money received'
          description='two wooden taps while zafu is open · it tells the room you were paid'
          checked={soundMoney}
          onChange={v => void setSetting('soundMoney', v)}
          {...explainProps('privacy.soundMoney')}
        />
      </Section>
      {sheet}
    </SettingsScreen>
  );
};
