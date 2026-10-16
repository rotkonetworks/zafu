import { useEffect, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { readNetEgress, setDestinationOptIn } from '../../../net/ledger';
import { readEgressInputs } from '../../../net/egress-opt-in';
import { NYM } from '../../../net/nym-bridge';
import {
  describeEgress,
  EGRESS_INPUT_KEYS,
  NYM_GROUPS,
  NYM_KEEP_READY,
  nymGroupKey,
  nymGroupView,
  type DestinationView,
  type EgressInputs,
} from '../../../net/egress-policy';
import type { NetEgressState } from '../../../net/destination';

/** send over nym: on unless the person blocked the nym destination; each
 *  network's own choice sits on a sheet (both stored with the egress choices) */
/** each network's line: what it shows when over nym, chosen direct, or out of nym's reach */
const LINE: Record<ReturnType<typeof nymGroupView>, (g: (typeof NYM_GROUPS)[number]) => string> = {
  nym: g => `over nym · ${g.nym}`,
  direct: g => `direct · ${g.direct}`,
  unreachable: () => "direct · your node can't be reached over nym",
};

export function SendOverNymRows({
  optIns,
  inputs,
  onExplain,
}: {
  optIns: NetEgressState['optIns'];
  /** the policy's inputs: the row reads the same node and backend the table does */
  inputs: EgressInputs;
  onExplain?: (label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const master = optIns[NYM] !== 'blocked';
  const keepReady = optIns[NYM_KEEP_READY] !== 'blocked';
  const view = (g: (typeof NYM_GROUPS)[number]) =>
    nymGroupView({ ...inputs, netEgress: { ...inputs.netEgress, optIns } }, g);
  return (
    <>
      <Row
        type='toggle'
        label='send over nym'
        description="slower · nym's directory sees that you use nym"
        checked={master}
        onChange={v => void setDestinationOptIn(NYM, v ? undefined : 'blocked')}
        onExplain={onExplain}
      />
      <Row
        type='value'
        label='nym, per network'
        value={`${NYM_GROUPS.filter(g => view(g) === 'nym').length} of ${NYM_GROUPS.length}`}
        disabled={!master}
        onPress={() => setOpen(true)}
        onExplain={onExplain}
      />
      <Sheet open={open} onOpenChange={setOpen} title='nym, per network'>
        <RowGroup className='mb-3'>
          {/* no-explain: its line says what it shows */}
          <Row
            type='toggle'
            label='keep nym ready while unlocked'
            description={
              keepReady
                ? 'the gateway sees you online while unlocked'
                : 'starts at a send · the first send waits'
            }
            checked={keepReady}
            onChange={v => void setDestinationOptIn(NYM_KEEP_READY, v ? undefined : 'blocked')}
          />
        </RowGroup>
        <RowGroup>
          {NYM_GROUPS.map(g => (
            // no-explain: each row says what going direct shows
            <Row
              key={g.id}
              type='toggle'
              label={g.label}
              description={LINE[view(g)](g)}
              checked={view(g) !== 'direct'}
              onChange={v => void setGroupNym(g, v)}
            />
          ))}
        </RowGroup>
      </Sheet>
    </>
  );
}

export interface Connections {
  inputs: EgressInputs;
  destinations: DestinationView[];
  ledger: NetEgressState;
}

/** The policy view and the ledger, re-read whenever one of their inputs changes. */
export const useConnections = (): Connections | undefined => {
  const [state, setState] = useState<Connections>();
  useEffect(() => {
    const keys = new Set<string>(EGRESS_INPUT_KEYS);
    const load = () =>
      void Promise.all([readEgressInputs(), readNetEgress()]).then(([inputs, ledger]) =>
        setState({ inputs, destinations: describeEgress(inputs), ledger }),
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

/** set one network's nym choice: back to its default, or an explicit yes or no */
const setGroupNym = (g: (typeof NYM_GROUPS)[number], v: boolean) =>
  setDestinationOptIn(nymGroupKey(g.id), v === g.on ? undefined : v ? 'allowed' : 'blocked');

/**
 * One quiet line where a network's sends wait on nym: how this send travels,
 * and the other way in one tap (the same switch as settings > connections).
 */
export function NymRouteLine({ group, slower }: { group: string; slower: string }) {
  const data = useConnections();
  const g = NYM_GROUPS.find(x => x.id === group);
  if (!data || !g || data.ledger.optIns[NYM] === 'blocked') {
    return null;
  }
  const view = nymGroupView({ ...data.inputs, netEgress: data.ledger }, g);
  if (view === 'unreachable') {
    return null;
  }
  const nym = view === 'nym';
  return (
    <div className='flex items-center justify-between gap-2 text-xs text-fg-muted'>
      <span>{nym ? `over nym · ${slower}` : `direct · ${g.direct}`}</span>
      <Button variant='quiet' size='sm' className='px-0' onClick={() => void setGroupNym(g, !nym)}>
        {nym ? 'send direct instead' : 'send over nym'}
      </Button>
    </div>
  );
}
