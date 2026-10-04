/**
 * check the seal (Cv2Seal, Cv2SealMatch, Cv2SealNoMatch): side by side, both
 * screens show the seal of the two relationship keys. The same on both means
 * the card you hold is theirs and theirs is yours; only then is the person
 * marked "seal checked". Until then they show where their card came from.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { ZidSeal } from '@repo/ui/components/ui/zid-seal';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../../../state/keyring';
import { deriveRelationshipKeys } from '../../../state/identity';
import { pairSeal } from '../../../people/cards';
import { ScreenHeader } from '../../../components/screen-header';
import { PopupPath, contactPath } from '../paths';

/** where a person's card came from, until the seal is checked */
export const sourceLine = (c: {
  sealChecked?: number;
  source?: 'link' | 'scan' | 'memo';
}): string | undefined =>
  c.sealChecked
    ? 'seal checked in person'
    : c.source === 'memo'
      ? 'from a memo'
      : c.source === 'scan'
        ? 'from a qr'
        : c.source
          ? 'from a link'
          : undefined;

const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }).toLowerCase();

/** the seal, as a picture and as the hex both screens can read aloud */
const useSeal = (contactId: string) => {
  const contact = useStore(s =>
    (Array.isArray(s.contacts.contacts) ? s.contacts.contacts : []).find(c => c.id === contactId),
  );
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const [mine, setMine] = useState<string>();
  const rel = contact?.rel;
  useEffect(() => {
    if (!rel || keyInfo?.type !== 'mnemonic') {
      return;
    }
    void getMnemonic(keyInfo.id).then(m => {
      const k = deriveRelationshipKeys(m, rel.gen, rel.j);
      k.seed.fill(0);
      k.kaSeed.fill(0);
      k.xwingSeed.fill(0);
      setMine(k.pubkey);
    });
  }, [rel, keyInfo, getMnemonic]);
  return { contact, seal: mine && contact?.zid ? pairSeal(mine, contact.zid) : undefined };
};

export function SealPage() {
  const navigate = useNavigate();
  const contactId = decodeURIComponent(useParams()['contactId'] ?? '');
  const { contact, seal } = useSeal(contactId);
  const updateContact = useStore(s => s.contacts.updateContact);
  const removeContact = useStore(s => s.contacts.removeContact);
  const [said, setSaid] = useState<'match' | 'no'>();
  const name = contact?.name ?? 'them';
  const back = () => navigate(contactPath(contactId), { replace: true });

  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader title='check the seal' backPath={PopupPath.CONTACTS} />
      <main className='flex grow flex-col items-center gap-4 px-4 py-6'>
        <span className='text-xs text-fg-muted'>you and {name}</span>
        {seal ? (
          <>
            <ZidSeal hex={seal} size={150} tone={said === 'match' ? 'hanko' : 'muted'} />
            <span className='font-mono text-sm tracking-wider text-fg-high'>
              {seal.slice(0, 16).match(/..../g)?.join(' ')}
            </span>
          </>
        ) : (
          <span
            className='size-[150px] border border-dashed border-border-hard'
            aria-hidden='true'
          />
        )}
        {said === 'match' ? (
          <div className='flex w-full flex-col border border-border-soft bg-elev-1 text-xs'>
            <span className='border-b border-border-soft px-3.5 py-2.5 text-fg-high'>
              seal checked in person · {day(contact?.sealChecked ?? Date.now())}
            </span>
            <span className='px-3.5 py-2.5 text-fg-muted'>
              before: {contact?.source === 'memo' ? 'from a memo' : 'from a link'}
            </span>
          </div>
        ) : said === 'no' ? (
          <div className='flex flex-col gap-2 text-center'>
            <span className='text-sm text-fg-high'>nothing was marked</span>
            <span className='text-xs text-fg-muted'>
              this card may not be {name}&apos;s own. please exchange a new card with {name}, in
              person.
            </span>
          </div>
        ) : (
          <span className='text-xs text-fg-muted'>
            {name} sees this same seal · compare side by side
          </span>
        )}
      </main>
      <footer className='flex shrink-0 gap-2 border-t border-border-soft px-4 pb-4 pt-3'>
        {said === 'match' ? (
          <Button className='flex-1' onClick={back}>
            done
          </Button>
        ) : said === 'no' ? (
          <>
            <Button
              variant='secondary'
              className='flex-1'
              onClick={() =>
                void removeContact(contactId).then(() =>
                  navigate(PopupPath.INBOX, { replace: true }),
                )
              }
            >
              remove {name}
            </Button>
            <Button
              className='flex-1'
              onClick={() => navigate(PopupPath.INBOX_ADD, { replace: true })}
            >
              make new cards together
            </Button>
          </>
        ) : (
          <>
            <Button
              variant='secondary'
              className='flex-1'
              disabled={!seal}
              onClick={() => setSaid('no')}
            >
              it does not match
            </Button>
            <Button
              className='flex-1'
              disabled={!seal}
              onClick={() =>
                void updateContact(contactId, { sealChecked: Date.now() }).then(() =>
                  setSaid('match'),
                )
              }
            >
              it matches
            </Button>
          </>
        )}
      </footer>
    </div>
  );
}

export default SealPage;
