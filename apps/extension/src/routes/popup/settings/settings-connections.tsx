/**
 * "everything zafu talks to": the egress policy (net/egress-policy.ts), one
 * row per destination.
 *
 *  - in use: what the enabled networks need. Blocking one asks first, since
 *    that network stops syncing.
 *  - optional: off until the user turns it on (here, or when a feature asks).
 *  - hosts the user answered one by one (a site's endpoint, a voting server).
 *  - networks not turned on: folded into a sheet, for reference.
 *
 * The screen only reads the policy and writes choices to the ledger; the
 * guard in every realm follows the change on its own.
 */
import { useEffect, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { EGRESS_INPUT_KEYS, type DestinationView } from '../../../net/egress-policy';
import { readEgressView } from '../../../net/egress-opt-in';
import type { NetEgressState } from '../../../net/destination';
import { readNetEgress, setDestinationDecision, setDestinationOptIn } from '../../../net/ledger';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';
import { ExplainSheet, type Explain } from './settings-explain';

interface Connections {
  destinations: DestinationView[];
  ledger: NetEgressState;
}

/** The policy view and the ledger, re-read whenever one of their inputs changes. */
const useConnections = (): Connections | undefined => {
  const [state, setState] = useState<Connections>();
  useEffect(() => {
    const keys = new Set<string>(EGRESS_INPUT_KEYS);
    const load = () =>
      void Promise.all([readEgressView(), readNetEgress()]).then(([destinations, ledger]) =>
        setState({ destinations, ledger }),
      );
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && Object.keys(changes).some(k => keys.has(k))) {
        load();
      }
    };
    load();
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  return state;
};

/** `zcash.rotko.net`, or `noble-rpc.polkachu.com +3` */
const hostsLine = (hosts: string[]) => {
  const names = [...new Set(hosts.map(h => h.split('/')[0]!))];
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : (names[0] ?? '');
};

/** what toggling a destination means, built from its own data - these hosts
 *  come from the egress policy at runtime, so there is no static copy to key
 *  by id; the row's own label, hosts and "needed" state are the explanation. */
const explainOf = (d: DestinationView): Explain => ({
  blurb: d.needed
    ? 'a host one of your enabled networks needs to work.'
    : 'off until you turn it on; zafu never contacts it otherwise.',
  on: `zafu can reach ${hostsLine(d.hosts)}`,
  off: d.needed
    ? `the networks that need it stop syncing: ${d.networks.join(', ') || 'this'}`
    : `zafu never contacts ${hostsLine(d.hosts)}`,
});

const DestinationRow = ({
  dest,
  onToggle,
  onExplain,
}: {
  dest: DestinationView;
  onToggle: (dest: DestinationView, next: boolean) => void;
  onExplain: () => void;
}) => (
  <Row
    type='toggle'
    label={dest.label}
    description={hostsLine(dest.hosts)}
    checked={dest.on}
    onChange={next => onToggle(dest, next)}
    onExplain={onExplain}
  />
);

export const SettingsConnections = () => {
  const data = useConnections();
  const [confirm, setConfirm] = useState<DestinationView>();
  const [unusedOpen, setUnusedOpen] = useState(false);
  const [explainDest, setExplainDest] = useState<DestinationView | null>(null);
  const [explainHost, setExplainHost] = useState<{
    host: string;
    label: string | undefined;
    state: string;
  } | null>(null);

  if (!data) {
    return (
      <SettingsScreen title='everything zafu talks to' backPath={PopupPath.SETTINGS_PRIVACY}>
        {null}
      </SettingsScreen>
    );
  }

  const listed = data.destinations.filter(d => d.hosts.length > 0);
  const inUse = listed.filter(d => d.needed);
  const optional = listed.filter(d => d.kind === 'optional');
  const unused = listed.filter(d => !d.needed && d.kind !== 'optional');
  const answered = Object.entries(data.ledger.destinations).filter(
    ([, r]) => r.state === 'allowed' || r.state === 'blocked',
  );

  const toggle = (dest: DestinationView, next: boolean) => {
    if (!next && dest.needed) {
      setConfirm(dest);
      return;
    }
    // a needed destination turned back on returns to its default; an optional
    // one is an explicit yes or no
    void setDestinationOptIn(dest.id, next ? (dest.needed ? undefined : 'allowed') : 'blocked');
  };

  return (
    <SettingsScreen title='everything zafu talks to' backPath={PopupPath.SETTINGS_PRIVACY}>
      <div className='flex flex-col gap-5'>
        <section>
          <p className='kicker mb-2'>in use</p>
          <RowGroup>
            {inUse.map(d => (
              <DestinationRow
                key={d.id}
                dest={d}
                onToggle={toggle}
                onExplain={() => setExplainDest(d)}
              />
            ))}
          </RowGroup>
        </section>

        <section>
          <p className='kicker mb-2'>optional, off until you ask</p>
          <RowGroup>
            {optional.map(d => (
              <DestinationRow
                key={d.id}
                dest={d}
                onToggle={toggle}
                onExplain={() => setExplainDest(d)}
              />
            ))}
          </RowGroup>
        </section>

        {answered.length > 0 && (
          <section>
            <p className='kicker mb-2'>hosts you answered</p>
            <RowGroup>
              {answered.map(([host, record]) => (
                <Row
                  key={host}
                  type='toggle'
                  label={host}
                  description={record.label || undefined}
                  checked={record.state === 'allowed'}
                  onChange={next => void setDestinationDecision(host, next ? 'allowed' : 'blocked')}
                  onExplain={() =>
                    setExplainHost({ host, label: record.label, state: record.state })
                  }
                />
              ))}
            </RowGroup>
          </section>
        )}

        {unused.length > 0 && (
          <RowGroup>
            {/* no-explain: opens a sheet whose own text is the full explanation */}
            <Row
              type='value'
              label='networks you have not turned on'
              value={String(unused.length)}
              onPress={() => setUnusedOpen(true)}
            />
          </RowGroup>
        )}
      </div>

      {explainDest && (
        <ExplainSheet
          title={explainDest.label}
          explain={explainOf(explainDest)}
          onOpenChange={() => setExplainDest(null)}
        />
      )}
      {explainHost && (
        <ExplainSheet
          title={explainHost.host}
          explain={{
            blurb: explainHost.label || 'a host you set an answer for yourself.',
            on: `zafu can reach ${explainHost.host}`,
            off: `zafu never contacts ${explainHost.host}`,
          }}
          onOpenChange={() => setExplainHost(null)}
        />
      )}

      <Sheet open={unusedOpen} onOpenChange={setUnusedOpen} title='not turned on'>
        <p className='text-label text-fg-muted lowercase'>
          zafu contacts these only once you turn their network on.
        </p>
        <div className='flex flex-col gap-3 overflow-y-auto'>
          {unused.map(d => (
            <div key={d.id} className='flex flex-col gap-0.5'>
              <span className='text-data text-fg-high lowercase'>{d.label}</span>
              {d.hosts.map(h => (
                <span key={h} className='break-all font-mono text-label text-fg-dim'>
                  {h}
                </span>
              ))}
            </div>
          ))}
        </div>
      </Sheet>

      <Sheet
        open={confirm !== undefined}
        onOpenChange={open => !open && setConfirm(undefined)}
        title={`block ${confirm?.label ?? ''}?`}
      >
        <p className='text-body text-fg-muted lowercase'>
          {confirm?.networks.length
            ? `${confirm.networks.join(' and ')} cannot sync while this is blocked.`
            : 'your network cannot be reached while this is blocked.'}
        </p>
        <div className='flex flex-col gap-2'>
          <Button
            variant='danger'
            onClick={() => {
              if (confirm) {
                void setDestinationOptIn(confirm.id, 'blocked');
              }
              setConfirm(undefined);
            }}
          >
            block
          </Button>
          <Button variant='secondary' onClick={() => setConfirm(undefined)}>
            not now
          </Button>
        </div>
      </Sheet>
    </SettingsScreen>
  );
};
