import { useEffect, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import {
  clearContactedEverywhere,
  dayOf,
  KEEP_DAYS,
  readContacted,
  totalContacted,
} from '../../../net/contacted';
import { readEgressView } from '../../../net/egress-opt-in';
import { clearNetEgressLog, readNetEgressLog } from '../../../net/ledger';
import { NYM } from '../../../net/nym-bridge';
import { PopupPath } from '../paths';
import { Section, SettingsScreen } from './settings-screen';

interface Line {
  key: string;
  name: string;
  what: string;
  at: number;
  /** contacts over the week and how they went; undefined for a refusal */
  count?: string;
}

const when = (at: number, now: number) =>
  dayOf(at) === dayOf(now)
    ? new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toLowerCase();

const times = (n: number) => (n === 1 ? 'once' : `${n.toLocaleString()} times`);

/** how a destination's contacts went: nym's own directory and gateways only set nym up */
const how = (id: string, n: number, nym: number) =>
  id === NYM ? "nym's own setup" : !nym ? 'direct' : nym === n ? 'over nym' : `${nym} over nym`;

/** the log by destination, newest first, and what zafu did not contact this week */
const load = async (now: number): Promise<{ contacted: Line[]; refused: Line[] }> => {
  const [log, view, refusals] = await Promise.all([
    readContacted(now),
    readEgressView(),
    readNetEgressLog(),
  ]);
  const byId = new Map(view.map(d => [d.id, d]));
  const contacted = Object.entries(log).map(([id, e]) => {
    const d = byId.get(id);
    const { n, nym } = totalContacted(e);
    return {
      key: id,
      name: d?.hosts[0]?.split('/')[0] ?? id,
      what: d?.label ?? 'a host you allowed',
      at: e.last,
      count: `${times(n)} · ${how(id, n, nym)}`,
    };
  });
  const oldest = (dayOf(now) - KEEP_DAYS + 1) * 86_400_000;
  const refused = refusals
    .filter(r => r.ts >= oldest)
    .map(r => ({
      key: `${r.host}${r.ts}`,
      name: r.host,
      what: r.outcome === 'blocked' ? 'you turned it off' : 'off until you ask',
      at: r.ts,
    }));
  return { contacted: contacted.sort((a, b) => b.at - a.at), refused };
};

const LineRow = ({ line, now }: { line: Line; now: number }) => (
  <div className='flex min-h-12 items-center gap-2.5 px-3 py-1.5'>
    <span className='flex min-w-0 grow flex-col gap-0.5'>
      <span className='break-all text-[13px] text-fg-high'>{line.name}</span>
      <span className='text-[11px] text-fg-muted'>{line.what}</span>
    </span>
    <span className='flex shrink-0 flex-col items-end gap-0.5'>
      <span className='text-xs text-fg'>{when(line.at, now)}</span>
      {line.count && <span className='text-[11px] text-fg-dim'>{line.count}</span>}
    </span>
  </div>
);

/** what zafu contacted lately: counts and times, on this computer only (SetContacted.dc.html) */
export const SettingsContacted = () => {
  const [now] = useState(Date.now);
  const [lines, setLines] = useState<Awaited<ReturnType<typeof load>>>();
  useEffect(() => {
    void load(now).then(setLines);
  }, [now]);

  const clear = async () => {
    await Promise.all([clearContactedEverywhere(), clearNetEgressLog()]);
    setLines({ contacted: [], refused: [] });
  };

  return (
    <SettingsScreen title='contacted lately' backPath={PopupPath.SETTINGS_NETWORK}>
      <div className='flex grow flex-col gap-4'>
        <p className='text-[11px] text-fg-dim'>kept on this computer only · the last 7 days</p>
        {lines && (
          <Section title='by destination'>
            {lines.contacted.length ? (
              lines.contacted.map(l => <LineRow key={l.key} line={l} now={now} />)
            ) : (
              <p className='px-3 py-4 text-xs text-fg-muted'>nothing contacted yet</p>
            )}
          </Section>
        )}
        {!!lines?.refused.length && (
          <Section title='not contacted'>
            {lines.refused.map(l => (
              <LineRow key={l.key} line={l} now={now} />
            ))}
          </Section>
        )}
        <div className='mt-auto flex items-center gap-2.5 border-t border-border-soft pt-3'>
          <span className='grow text-[11px] text-fg-muted'>nothing here leaves this computer</span>
          <Button
            variant='secondary'
            size='sm'
            className='shrink-0 whitespace-nowrap'
            onClick={() => void clear()}
          >
            clear this list
          </Button>
        </div>
      </div>
    </SettingsScreen>
  );
};
