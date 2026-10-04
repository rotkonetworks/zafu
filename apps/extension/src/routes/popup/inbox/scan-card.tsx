/**
 * scan a card (Cv2Scan): the camera, or their link pasted. Either way the
 * card opens on the received screen, which checks it before anything is saved.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { ScreenHeader } from '../../../components/screen-header';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { parseLink } from '../../../links/router';
import { PopupPath } from '../paths';

/** the card in whatever was scanned or pasted, as the card screen's route */
export const cardRoute = (raw: string, via: 'scanned' | 'pasted'): string | undefined => {
  const t = raw.trim();
  const p = parseLink(/^(zafu:|https?:\/\/)/.test(t) ? t : `https://${t}`);
  return p.ok && p.intent.kind === 'contact'
    ? `${PopupPath.CONTACT_CARD}?card=${encodeURIComponent(p.intent.card)}&via=${via}`
    : undefined;
};

export function ScanCardPage() {
  const navigate = useNavigate();
  const [link, setLink] = useState('');
  const [wrong, setWrong] = useState(false);
  const go = (raw: string, via: 'scanned' | 'pasted') => {
    const to = cardRoute(raw, via);
    if (to) {
      navigate(to, { replace: true });
    } else {
      setWrong(true);
    }
  };
  return (
    <div className='flex min-h-full flex-col'>
      <ScreenHeader title='add a person' backPath={PopupPath.INBOX} />
      <main className='flex grow flex-col gap-3.5 px-4 pb-4 pt-3.5'>
        <QrScanner
          inline
          title='looking for a card'
          onScan={text => go(text, 'scanned')}
          onClose={() => undefined}
        />
        <form
          className='flex flex-col gap-1.5'
          onSubmit={e => {
            e.preventDefault();
            go(link, 'pasted');
          }}
        >
          <label htmlFor='card-link' className='text-xs text-fg-muted'>
            or paste their link
          </label>
          <div className='flex gap-2'>
            <Input
              id='card-link'
              placeholder='zafu.pro/c#…'
              value={link}
              onChange={e => {
                setLink(e.target.value);
                setWrong(false);
              }}
              className='grow font-mono text-xs'
            />
            <Button type='submit' variant='secondary' disabled={!link.trim()}>
              open
            </Button>
          </div>
          {wrong && (
            <span className='text-[11px] text-fg-muted'>
              that does not look like a card. please try another.
            </span>
          )}
        </form>
      </main>
      <footer className='flex shrink-0 border-t border-border-soft px-4 pb-4 pt-3'>
        <Button
          variant='secondary'
          className='w-full'
          onClick={() => navigate(PopupPath.INBOX_ADD, { replace: true })}
        >
          show my card instead
        </Button>
      </footer>
    </div>
  );
}

export default ScanCardPage;
