import { useState } from 'react';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { setDestinationOptIn } from '../../../net/ledger';
import { NYM } from '../../../net/nym-bridge';
import {
  NYM_GROUPS,
  NYM_KEEP_READY,
  nymGroupKey,
  nymGroupView,
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
              onChange={v =>
                void setDestinationOptIn(
                  nymGroupKey(g.id),
                  v === g.on ? undefined : v ? 'allowed' : 'blocked',
                )
              }
            />
          ))}
        </RowGroup>
      </Sheet>
    </>
  );
}
