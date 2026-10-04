/**
 * The slot under a title (design-social 5.0): one fixed-height line that says
 * where the relay stands, with the one thing to do about it. It never grows;
 * nothing below it moves when it changes.
 */

import { useNavigate } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { PopupPath } from '../routes/popup/paths';
import { requestEgressOptIn } from '../net/egress-opt-in';
import { PEOPLE_RELAY } from '../config/people-relay';
import { peopleAsk, usePeople } from './client';
import type { PeopleSlot } from './service';

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export const RelaySlot = ({ waiting }: { waiting?: string }) => {
  const navigate = useNavigate();
  const status = usePeople().status;
  const slot: PeopleSlot = status?.slot ?? 'idle';
  const again = () => void peopleAsk('check').catch(() => undefined);
  const allow = () =>
    void requestEgressOptIn(PEOPLE_RELAY).then(
      ok => ok && again(),
      () => undefined,
    );
  const line: { text: string; action?: [string, () => void]; tone?: 'warn' } | undefined = waiting
    ? { text: waiting }
    : slot === 'checking'
      ? { text: 'checking' }
      : slot === 'checked' && status
        ? { text: `checked ${hhmm(status.at)}`, action: ['check again', again] }
        : slot === 'needs-opt-in'
          ? { text: 'messages wait until the relay is allowed', action: ['allow', allow] }
          : slot === 'blocked'
            ? {
                text: 'the relay is blocked in what zafu talks to',
                action: ['open connections', () => navigate(PopupPath.SETTINGS_CONNECTIONS)],
              }
            : slot === 'offline'
              ? { text: 'you seem to be offline. nothing is lost; messages wait here.' }
              : slot === 'unreachable'
                ? {
                    text: 'the relay did not answer. we will try again when you ask.',
                    action: ['check again', again],
                    tone: 'warn',
                  }
                : slot === 'oversize'
                  ? {
                      text: 'some messages could not be read. this is on our side.',
                      action: ['check again', again],
                      tone: 'warn',
                    }
                  : undefined;
  return (
    <div className='flex h-8 shrink-0 items-center justify-between gap-3 border-b border-border-soft px-4 text-[11px]'>
      <span className={cn('truncate', line?.tone === 'warn' ? 'text-warn' : 'text-fg-muted')}>
        {line?.text}
      </span>
      {line?.action && (
        <button
          type='button'
          onClick={line.action[1]}
          className='shrink-0 text-zigner-gold hover:underline'
        >
          {line.action[0]}
        </button>
      )}
    </div>
  );
};
