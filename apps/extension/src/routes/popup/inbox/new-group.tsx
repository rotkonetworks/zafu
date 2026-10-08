/**
 * make a group (NewGroup.dc.html), or a shared wallet: a name, then its
 * code. Whoever types the code's words comes in; a shared wallet makes its
 * keys by itself once everyone is there.
 */

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Segmented } from '@repo/ui/components/ui/segmented';
import { ScreenHeader } from '../../../components/screen-header';
import { peopleAsk } from '../../../people/client';
import { isRelayGated } from '../../../people/protocol';
import { majority } from '../../../people/frost-room';
import { PopupPath, groupInvitePath } from '../paths';
import { NickField } from './nick-field';
import { Seals } from './shared-wallet';

type Kind = 'chat' | 'wallet';

export function NewGroupPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const kind: Kind = params.get('wallet') ? 'wallet' : 'chat';
  const [name, setName] = useState('');
  const [nick, setNick] = useState('');
  const [n, setN] = useState(3);
  const [k, setK] = useState(majority(3));
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string>();
  const wallet = kind === 'wallet';
  const label = name.trim() || (wallet ? 'shared wallet' : '');

  const create = async () => {
    setBusy(true);
    setFail(undefined);
    try {
      const { id } = await peopleAsk<{ id: string; code: string }>('group-create', {
        name: label,
        nick: nick.trim(),
        ...(wallet ? { k: Math.min(k, n), n } : {}),
      });
      navigate(groupInvitePath(id.slice(2)), { replace: true });
    } catch (e) {
      setFail(
        isRelayGated(e)
          ? 'a group needs the relay · nothing was made'
          : 'sorry, zafu could not make it. please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className='flex h-full flex-col'>
      <ScreenHeader title={wallet ? 'shared wallet' : 'new group'} backPath={PopupPath.INBOX} />
      <form
        className='flex min-h-0 grow flex-col'
        onSubmit={e => {
          e.preventDefault();
          if (label && !busy) {
            void create();
          }
        }}
      >
        <div className='flex min-h-0 grow flex-col gap-[18px] overflow-y-auto px-4 pb-3 pt-3.5'>
          <Segmented<Kind>
            label='what to make'
            value={kind}
            onChange={v => setParams(v === 'wallet' ? { wallet: '1' } : {}, { replace: true })}
            options={[
              { value: 'chat', label: 'group chat' },
              { value: 'wallet', label: 'shared wallet' },
            ]}
          />
          <label className='flex flex-col gap-1.5'>
            <span className='text-xs tracking-[0.04em] text-fg-muted'>name</span>
            <Input
              aria-label='name'
              placeholder={wallet ? 'shared wallet' : 'treasury'}
              value={name}
              maxLength={48}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
          </label>
          <NickField value={nick} onChange={setNick} />
          {wallet && (
            <section className='flex flex-col gap-1.5'>
              <Seals
                k={n}
                n={8}
                label='people, you included'
                onK={m => {
                  setN(m);
                  setK(majority(m));
                }}
              />
              <Seals k={Math.min(k, n)} n={n} onK={setK} />
              <span className='text-[11px] text-fg-muted'>
                any {Math.min(k, n)} of you {n} can send · each device holds one key
              </span>
            </section>
          )}
          <span className='text-[11px] text-fg-muted'>
            the next step makes a code · each code lets one person in
          </span>
        </div>
        {/* pinned above the tabs, however long the form */}
        <div className='flex shrink-0 flex-col gap-1 px-4 pb-4'>
          <div className='h-5 text-[11px] text-hanko-light'>{fail}</div>
          <Button type='submit' disabled={!label || busy} loading={busy}>
            {wallet ? 'start' : 'invite and create'}
          </Button>
        </div>
      </form>
    </div>
  );
}

export default NewGroupPage;
