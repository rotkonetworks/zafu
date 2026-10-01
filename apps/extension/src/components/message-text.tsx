/**
 * Chat message text where a `zcash:` or `zafu:` link becomes a chip that
 * opens the screen it fills, for review. Payment requests travel through
 * chats as often as QR codes. A link zafu can't open stays plain text.
 */

import { describeIntent } from '../links/describe';
import { notYet, parseLink } from '../links/router';
import { PopupPath } from '../routes/popup/paths';
import { usePopupNav } from '../utils/navigate';

const LINK = /(?:zcash|zafu):[^\s<>"']+/gi;

const LinkChip = ({ uri }: { uri: string }) => {
  const navigate = usePopupNav();
  const parsed = parseLink(uri);
  if (!parsed.ok || notYet(parsed.intent)) {
    return <>{uri}</>;
  }
  return (
    <button
      type='button'
      onClick={() => navigate(PopupPath.LINK, { state: { uri, via: 'message' } })}
      title={uri}
      className='my-0.5 inline-flex items-center gap-1 border border-zigner-gold/40 bg-zigner-gold/10 px-2 py-0.5 text-xs text-zigner-gold hover:bg-zigner-gold/20'
    >
      <span className='i-ph-coins h-3 w-3' />
      {describeIntent(parsed.intent)}
    </button>
  );
};

/** text split into plain runs and `zcash:` / `zafu:` links (trailing punctuation left out) */
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
        typeof part === 'string' ? part : <LinkChip key={`${i}-${part.uri}`} uri={part.uri} />,
      )}
    </>
  );
};
