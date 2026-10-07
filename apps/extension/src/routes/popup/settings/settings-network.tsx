import { useEffect, useState, type ReactNode } from 'react';
import { Row } from '@repo/ui/components/ui/row';
import { useStore } from '../../../state';
import { readEgressView } from '../../../net/egress-opt-in';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { Section, SettingsScreen } from './settings-screen';
import { ApprovalsRow } from './settings-appearance';
import { selectConnectedSiteCount } from './settings-status';
import { useExplain, type ExplainId } from './settings-explain';
import { DiscoveryRelayRow, PeopleRelayRow, useDiscoveryOn } from './relay-rows';

type Explain = (id: ExplainId) => { onExplain?: (label: string) => void };
type NetworkRow = (p: { explainProps: Explain }) => ReactNode;

const TalksToRow: NetworkRow = () => {
  const navigate = usePopupNav();
  const [on, setOn] = useState<number>();
  useEffect(() => {
    void readEgressView().then(v => setOn(v.filter(d => d.on && d.hosts.length).length));
  }, []);
  return (
    <Row
      type='value'
      label='everything zafu talks to'
      description='chain · people · swap and buy · voting'
      value={on === undefined ? undefined : `${on} on`}
      preload={PopupPath.SETTINGS_CONNECTIONS}
      onPress={() => navigate(PopupPath.SETTINGS_CONNECTIONS)}
    />
  );
};

const ContactedRow: NetworkRow = () => {
  const navigate = usePopupNav();
  return (
    <Row
      type='screen'
      label='what zafu contacted lately'
      description='kept on this computer only'
      preload={PopupPath.SETTINGS_CONTACTED}
      onPress={() => navigate(PopupPath.SETTINGS_CONTACTED)}
    />
  );
};

const PeopleRelay: NetworkRow = ({ explainProps }) => (
  <PeopleRelayRow {...explainProps('privacy.peopleRelay')} />
);

/** discovery's relay, while zid and discovery are on */
const DiscoveryRelay: NetworkRow = ({ explainProps }) => {
  const zid = useStore(s => s.privacy.settings.enableIdentity);
  const discovery = useDiscoveryOn();
  return zid && discovery ? (
    <DiscoveryRelayRow {...explainProps('privacy.contactDiscoveryRelay')} />
  ) : null;
};

const SitesRow: NetworkRow = () => {
  const navigate = usePopupNav();
  return (
    <Row
      type='value'
      label='connected sites'
      description='a site sees only what you approve'
      value={String(useStore(selectConnectedSiteCount))}
      preload={PopupPath.SETTINGS_CONNECTED_SITES}
      onPress={() => navigate(PopupPath.SETTINGS_CONNECTED_SITES)}
    />
  );
};

const FeaturesRow: NetworkRow = () => {
  const navigate = usePopupNav();
  return (
    <Row
      type='screen'
      label='what sites may ask'
      description='ask, on or off for each kind of request'
      preload={PopupPath.SETTINGS_FEATURES}
      onPress={() => navigate(PopupPath.SETTINGS_FEATURES)}
    />
  );
};

const Approvals: NetworkRow = ({ explainProps }) => (
  <ApprovalsRow description='nobody else sees this' {...explainProps('appearance.approvals')} />
);

const ZafuLinksRow: NetworkRow = ({ explainProps }) => {
  const on = useStore(s => s.privacy.settings.openZafuLinks);
  const setSetting = useStore(s => s.privacy.setSetting);
  return (
    <Row
      type='toggle'
      label='open zafu: links'
      description='a page can fill a screen · you review it'
      checked={on}
      onChange={v => void setSetting('openZafuLinks', v)}
      {...explainProps('privacy.zafuLinks')}
    />
  );
};

/**
 * The network screen, as data. "how zafu goes out" is the transport slot:
 * empty (and so not drawn) until "send over nym" (#84) adds its row there.
 */
const SECTIONS: readonly { title: string; rows: readonly NetworkRow[] }[] = [
  { title: 'how zafu goes out', rows: [] },
  { title: 'destinations', rows: [TalksToRow, ContactedRow, PeopleRelay, DiscoveryRelay] },
  { title: 'sites', rows: [SitesRow, FeaturesRow, Approvals, ZafuLinksRow] },
];

/** network: who sees you online (SetNetworks.dc.html) */
export const SettingsNetwork = () => {
  const { explainProps, sheet } = useExplain();
  return (
    <SettingsScreen title='network' category='network' home backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4'>
        {SECTIONS.filter(s => s.rows.length).map(s => (
          <Section key={s.title} title={s.title}>
            {s.rows.map((R, i) => (
              <R key={i} explainProps={explainProps} />
            ))}
          </Section>
        ))}
      </div>
      {sheet}
    </SettingsScreen>
  );
};
