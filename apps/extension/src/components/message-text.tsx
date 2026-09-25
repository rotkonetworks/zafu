/**
 * Chat message text where a `zcash:` payment link (ZIP 321) becomes a "pay"
 * chip that opens send, prefilled for review. Payment requests travel through
 * chats as often as QR codes. Anything that isn't a well-formed
 * single-payment link stays plain text.
 */

import { useNavigate } from 'react-router-dom';
import { formatZecAmount, parseZip321 } from '@repo/wallet/networks/zcash/zip321';
import { PopupPath } from '../routes/popup/paths';

const LINK = /zcash:[^\s<>"']+/gi;

const PayChip = ({ uri }: { uri: string }) => {
  const navigate = useNavigate();
  const parsed = parseZip321(uri);
  const p = parsed.ok && parsed.payments.length === 1 ? parsed.payments[0] : undefined;
  if (!p) {
    return <>{uri}</>;
  }
  const what = [
    p.amountZat !== undefined ? `${formatZecAmount(p.amountZat)} ZEC` : 'pay',
    p.label ?? p.message,
  ]
    .filter(Boolean)
    .join(' - ');
  return (
    <button
      type='button'
      onClick={() => navigate(`${PopupPath.SEND}?to=${encodeURIComponent(uri)}`)}
      title={uri}
      className='my-0.5 inline-flex items-center gap-1 border border-zigner-gold/40 bg-zigner-gold/10 px-2 py-0.5 text-xs text-zigner-gold hover:bg-zigner-gold/20'
    >
      <span className='i-ph-coins h-3 w-3' />
      {p.amountZat !== undefined ? `pay ${what}` : what}
    </button>
  );
};

/** text split into plain runs and `zcash:` links (trailing punctuation left out) */
export const splitPaymentLinks = (text: string): (string | { uri: string })[] => {
  const parts: (string | { uri: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const at = m.index;
    if (at > last) {
      parts.push(text.slice(last, at));
    }
    const uri = m[0].replace(/[.,;:!?)]+$/, '');
    parts.push({ uri });
    last = at + uri.length;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts;
};

export const MessageText = ({ text }: { text: string }) => {
  const parts = splitPaymentLinks(text);
  return (
    <>
      {parts.map((part, i) =>
        typeof part === 'string' ? part : <PayChip key={`${i}-${part.uri}`} uri={part.uri} />,
      )}
    </>
  );
};
