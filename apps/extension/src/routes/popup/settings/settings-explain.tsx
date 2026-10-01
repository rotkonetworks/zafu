/**
 * The "?" sheet a privacy-settings row opens (SetExplain.dc.html): one line
 * on what the setting does, then what on and off each mean. Informational
 * only - the row's own toggle stays the single place that setting is set.
 */

import { useState } from 'react';
import { Sheet } from '@repo/ui/components/ui/sheet';

export interface Explain {
  blurb: string;
  on: string;
  off: string;
  footer?: string;
}

export const PRIVACY_EXPLAIN: Record<string, Explain> = {
  'hide balances': {
    blurb: 'blurs every amount on screen until you tap to reveal it.',
    on: 'a shoulder-surfer sees shapes, not numbers',
    off: 'balances show plainly, as on most wallets',
  },
  'transaction history': {
    blurb: 'keeps a list of your past sends and receives in zafu.',
    on: 'the home screen and detail sheets show past activity',
    off: 'nothing is listed; past transactions still happened on-chain',
  },
  'price display': {
    blurb: 'shows a fiat estimate next to on-chain amounts.',
    on: 'zafu asks a price service to convert the figure shown',
    off: 'amounts show only in the asset itself, no price lookup',
  },
  'background sync': {
    blurb: 'keeps cosmos balances current while zafu is closed.',
    on: 'zafu asks the cosmos nodes now and then, even when closed',
    off: 'zafu checks only when you ask',
  },
  'explorer links': {
    blurb: 'adds a link from each transaction to a public block explorer.',
    on: 'handy for checking a transaction landed',
    off: 'the explorer never learns which transactions you look at',
    footer: 'off by default · zafu also asks the first time you tap a transaction id',
  },
  'zcash: links': {
    blurb: 'lets zafu open zcash: payment links from other pages.',
    on: 'tapping a zcash: link opens it straight into send',
    off: 'the browser hands those links to your other zcash app',
  },
  'zafu: links': {
    blurb: 'lets zafu open zafu: links from other pages, like a swap or a screen.',
    on: 'tapping a zafu: link opens the screen it fills, for you to review',
    off: 'those links stay with the page',
  },
  'private contact discovery': {
    blurb: 'finds which of your contacts also use zafu, without sharing your list.',
    on: 'while zafu is open, it leaves a sealed sign on the relay you choose',
    off: 'zafu never contacts the relay for this',
  },
  'zcash.me': {
    blurb: 'find people by their zcash.me name.',
    on: 'zafu asks zcash.me about the names you look up',
    off: 'zafu never contacts zcash.me',
  },
};

/** one label open at a time, so every row in a screen shares one sheet */
export const useExplain = () => {
  const [label, setLabel] = useState<string | null>(null);
  const explain = label ? PRIVACY_EXPLAIN[label] : undefined;
  return {
    /** spread onto a Row - a no-op when the label has no explain copy */
    explainProps: (l: string) => (PRIVACY_EXPLAIN[l] ? { onExplain: () => setLabel(l) } : {}),
    sheet: label && explain && (
      <ExplainSheet label={label} explain={explain} onOpenChange={() => setLabel(null)} />
    ),
  };
};

const ExplainSheet = ({
  label,
  explain,
  onOpenChange,
}: {
  label: string;
  explain: Explain;
  onOpenChange: (open: boolean) => void;
}) => (
  <Sheet open title={label} onOpenChange={onOpenChange}>
    <p className='text-sm leading-relaxed text-fg'>{explain.blurb}</p>
    <div className='flex flex-col border border-surface-border-soft'>
      <div className='flex gap-2.5 px-3 py-2.5 text-xs leading-relaxed'>
        <span className='w-9 shrink-0 text-success'>on</span>
        <span className='text-fg-muted'>{explain.on}</span>
      </div>
      <div className='flex gap-2.5 border-t border-surface-border-soft px-3 py-2.5 text-xs leading-relaxed'>
        <span className='w-9 shrink-0 text-warn'>off</span>
        <span className='text-fg-muted'>{explain.off}</span>
      </div>
    </div>
    {explain.footer && <span className='text-[11px] text-fg-dim'>{explain.footer}</span>}
  </Sheet>
);
