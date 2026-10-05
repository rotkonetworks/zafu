/**
 * make a group (NewGroup.dc.html), chat only: a name, then its door. People
 * come in by the code it makes, each one let in by you; a person you already
 * have an address for can be sent the invite in a memo from the door.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { ScreenHeader } from '../../../components/screen-header';
import { peopleAsk } from '../../../people/client';
import { isRelayGated } from '../../../people/protocol';
import { PopupPath, groupInvitePath } from '../paths';
import { NickField } from './nick-field';

export function NewGroupPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [nick, setNick] = useState('');
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string>();

  const create = async () => {
    setBusy(true);
    setFail(undefined);
    try {
      const { id } = await peopleAsk<{ id: string; code: string }>('group-create', {
        name: name.trim(),
        nick: nick.trim(),
      });
      navigate(groupInvitePath(id.slice(2)), { replace: true });
    } catch (e) {
      setFail(
        isRelayGated(e)
          ? 'a group needs the relay · nothing was made'
          : 'sorry, zafu could not make the group. please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader title='new group' backPath={PopupPath.INBOX} />
      <form
        className='flex grow flex-col gap-[18px] px-4 pb-4 pt-3.5'
        onSubmit={e => {
          e.preventDefault();
          if (name.trim() && !busy) {
            void create();
          }
        }}
      >
        <label className='flex flex-col gap-1.5'>
          <span className='text-xs tracking-[0.04em] text-fg-muted'>name</span>
          <Input
            aria-label='name'
            placeholder='treasury'
            value={name}
            maxLength={48}
            onChange={e => setName(e.target.value)}
            autoFocus
          />
        </label>
        <NickField value={nick} onChange={setNick} />
        <section className='flex flex-col gap-1.5'>
          <h2 className='text-xs tracking-[0.04em] text-fg-muted'>members</h2>
          <div className='flex h-12 items-center gap-3 px-1'>
            <span className='flex size-8 items-center justify-center bg-elev-2 text-sm text-fg-high'>
              y
            </span>
            <span className='grow text-sm text-fg-high'>{nick.trim() || 'you'}</span>
          </div>
          <span className='text-[11px] text-fg-muted'>
            or share code · the next step makes one, and you allow each person
          </span>
        </section>
        <div className='h-5 text-[11px] text-hanko-light'>{fail}</div>
        <div className='mt-auto flex flex-col gap-3'>
          <Button type='submit' disabled={!name.trim() || busy} loading={busy}>
            invite and create
          </Button>
        </div>
      </form>
    </div>
  );
}

export default NewGroupPage;
