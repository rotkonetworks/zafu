/**
 * The "?" sheet a settings row opens (SetExplain.dc.html): one line on what
 * the setting does, then what each state means. Informational only - the
 * row's own control (toggle, or the sheet it opens) stays the single place
 * that setting is set.
 *
 * Keyed by a stable id (e.g. 'privacy.hideBalances'), never by the row's
 * label text - labels are copy and copy changes; ids don't. One table for
 * every settings screen, so the mechanism stays single and small.
 */

import { useState } from 'react';
import { Sheet } from '@repo/ui/components/ui/sheet';

export interface Explain {
  /** one line: what the setting does */
  blurb: string;
  /** binary row: what "on" means */
  on?: string;
  /** binary row: what "off" means */
  off?: string;
  /** choice row (more than two states): one line per option, in the order shown */
  states?: readonly { label: string; text: string }[];
  footer?: string;
}

export const SETTINGS_EXPLAIN = {
  'privacy.hideBalances': {
    blurb: 'blurs every amount on screen until you tap to reveal it.',
    on: 'a shoulder-surfer sees shapes, not numbers',
    off: 'balances show plainly, as on most wallets',
  },
  'privacy.txHistory': {
    blurb: 'keeps a list of your past sends and receives in zafu.',
    on: 'the home screen and detail sheets show past activity',
    off: 'nothing is listed; past transactions still happened on-chain',
  },
  'privacy.priceDisplay': {
    blurb: 'shows a fiat estimate next to on-chain amounts.',
    on: 'zafu asks a price service to convert the figure shown',
    off: 'amounts show only in the asset itself, no price lookup',
  },
  'privacy.transparentBalances': {
    blurb: 'what waits on your deposit addresses, before it is shielded.',
    on: 'zafu asks the nodes you picked, from your ip, when you tap a transparent line',
    off: 'nothing is asked; zafu asks you first, the next time you tap one',
  },
  'privacy.explorerLinks': {
    blurb: 'adds a link from each transaction to a public block explorer.',
    on: 'handy for checking a transaction landed',
    off: 'the explorer never learns which transactions you look at',
    footer: 'off by default · zafu also asks the first time you tap a transaction id',
  },
  'privacy.zcashLinks': {
    blurb: 'lets zafu open zcash: payment links from other pages.',
    on: 'tapping a zcash: link opens it straight into send',
    off: 'the browser hands those links to your other zcash app',
  },
  'privacy.zafuLinks': {
    blurb: 'lets zafu open zafu: links from other pages, like a swap or a screen.',
    on: 'tapping a zafu: link opens the screen it fills, for you to review',
    off: 'those links stay with the page',
  },
  'privacy.zidIdentity': {
    blurb: 'the zid layer: signing in to sites, per-site identities, encrypted messaging.',
    on: 'sites can ask for a zid, approvals work, messages decrypt',
    off: 'the identity surface is hidden and those requests get "identity disabled" - your recovery phrase and funds are untouched',
    footer: 'you can turn this back on any time; the same zids come back',
  },
  'privacy.contactDiscovery': {
    blurb: 'finds which of your contacts also use zafu, without sharing your list.',
    on: 'while zafu is open, it leaves a sealed sign on the relay you choose',
    off: 'zafu never contacts the relay for this',
  },
  'privacy.contactDiscoveryRelay': {
    blurb: 'which relay carries the sealed presence signs for contact discovery.',
    footer:
      'leaving it blank uses the built-in default relay; either way, the relay never sees your contact list, only that a sealed sign was left',
  },
  'privacy.zcashMe': {
    blurb: 'find people by their zcash.me name (opt-in; off by default).',
    states: [
      { label: 'off', text: 'nothing ever leaves the wallet for this' },
      {
        label: 'local directory',
        text: 'one bulk download of the whole directory; every lookup after that is a local read - zcash.me learns that you use the feature, not who you pay',
      },
      {
        label: 'live lookup',
        text: '/name is resolved on demand - zcash.me sees your ip and every name you look up',
      },
    ],
  },
  'privacy.zcashMemoDecoys': {
    blurb: 'how zafu asks your node for the memos on your zcash transactions.',
    on: 'zafu adds 2 random decoy buckets for every real one it needs (and shuffles the order), so the node cannot tell which of the buckets it fetched are actually yours',
    off: 'zafu fetches only the real buckets - a third as many requests, at double the concurrency',
    footer:
      'either way zafu asks for a bucket of blocks, never one transaction by id - the node learns a range of blocks you were interested in, never which transaction inside it is yours',
  },
  'privacy.zcashInstantPending': {
    blurb: 'shows an incoming or outgoing zcash payment before it is mined.',
    on: 'while zafu is open, it asks your node for the whole mempool roughly every 10 seconds, so the node sees a wallet checking in on that cadence - it does not learn which pending payment is yours, since it hands back the whole mempool each time',
    off: 'zafu never asks about the mempool; a payment only appears once it is mined into a block',
  },
  'network.keepSyncingClosed': {
    blurb: 'lets penumbra keep reading new blocks after the last zafu window closes.',
    on: 'penumbra is caught up when you open zafu; its node sees zafu reading while closed',
    off: 'penumbra pauses with the last window and catches up when you open zafu',
  },
  'network.zcashNode': {
    blurb: 'which node zafu reads the zcash chain from, and asks for your memos.',
    states: [
      {
        label: 'verified',
        text: 'the node proves the chain it serves and zafu checks every proof; it also offers memo decoys and instant pending',
      },
      {
        label: 'no mark',
        text: 'zafu reads the chain as other light wallets do, trusting what the node returns',
      },
    ],
    footer:
      'any node you pick - preset or your own - learns your ip and roughly when you sync, never your keys',
  },
  'network.penumbraNode': {
    blurb: 'which node zafu reads the penumbra chain from.',
    footer:
      'any node you pick - preset or your own - learns your ip and roughly when you sync, never your keys',
  },
  'network.ownNode': {
    blurb: 'point zafu at a node address you choose, instead of one of the built-in presets.',
    footer:
      'whoever runs that node sees the same things a preset node would: your ip and roughly when you sync',
  },
  'network.ibcChains': {
    blurb: 'cosmos chains reachable over ibc from your penumbra balance.',
    footer: "zafu only contacts a chain's own node once you turn that chain on",
  },
  'network.ibcChainToggle': {
    blurb: 'turns this ibc chain on, so you can hold and move its asset.',
    on: 'zafu reads this chain from its own node, the one shown in its settings',
    off: 'zafu never contacts this chain',
  },
  'network.totalIn': {
    blurb: 'the unit the penumbra total on your home screen is shown in.',
    states: [
      { label: 'um', text: 'the native unit; no price lookup at all' },
      {
        label: 'usd',
        text: 'a fiat estimate from recent swap prices your own penumbra node already recorded - no separate external price service is asked',
      },
    ],
  },
  'network.zcashStartsFrom': {
    blurb: 'the block zafu starts scanning from for this wallet.',
    footer:
      "leaving it on auto scans recent blocks for you, which can miss an old wallet's early activity - set a date or block if you know roughly when it was first used",
  },
  'network.penumbraResync': {
    blurb:
      "forgets what zafu has found on penumbra and reads the chain again from your wallet's own start.",
    footer:
      "useful if penumbra's balance looks wrong or a payment you received is missing. this resyncs penumbra for every wallet on this computer; your keys and your funds are untouched.",
  },
  'network.zcashEnable': {
    blurb: 'turns the zcash network on or off in zafu.',
    on: 'zafu shows your zcash balance and syncs it from your chosen node',
    off: 'zcash is hidden everywhere in zafu; your keys are untouched and nothing is asked of any zcash node',
  },
  'network.penumbraEnable': {
    blurb: 'turns the penumbra network on or off in zafu.',
    on: 'zafu shows your penumbra balance and syncs it from your chosen node',
    off: 'penumbra is hidden everywhere in zafu; your keys are untouched and nothing is asked of any penumbra node',
  },
  'appearance.theme': {
    blurb: 'the color scheme zafu draws itself in.',
    states: [
      { label: 'sumi', text: 'dark - warm ink on woven cloth' },
      { label: 'washi', text: 'light - ink on unbleached paper' },
    ],
  },
  'appearance.font': {
    blurb: 'the typeface used across zafu.',
    states: [
      { label: 'iosevka term', text: 'the built-in monospace face' },
      { label: 'system mono', text: "your device's own monospace font" },
    ],
  },
  'appearance.approvals': {
    blurb: "where a dapp's approval request (sign, connect, send) opens.",
    states: [
      {
        label: 'side panel or window',
        text: 'a side panel when the browser can open one, otherwise a small window',
      },
      { label: 'side panel only', text: 'always the side panel' },
      { label: 'a window', text: 'always a small separate window' },
    ],
  },
  'security.autoLock': {
    blurb: 'how long zafu stays unlocked with nothing happening before it locks itself.',
    states: [
      { label: 'off', text: 'zafu never locks itself on idle time' },
      {
        label: '1, 5, 15, 30 or 60 min',
        text: 'the shorter the time, the less of a window if you leave zafu open and walk away',
      },
    ],
    footer: '15 min by default',
  },
  'security.txSigning': {
    blurb: 'when zafu asks for your password to sign a transaction.',
    states: [
      { label: 'unlock only', text: 'being unlocked is enough; no extra password step' },
      {
        label: 'grace 15 min',
        text: 'the password is asked again if 15 minutes passed since you last typed it',
      },
      { label: 'foil hat', text: 'the password is asked every single time, no exceptions' },
    ],
  },
  'devices.actAsKeplr': {
    blurb: 'answers cosmos sites that only know the window.keplr api, as if zafu were keplr.',
    on: 'those sites can connect to zafu; takes effect on the next page load',
    off: 'those sites see no wallet from zafu; a real keplr extension, if installed, is left untouched',
  },
} as const satisfies Record<string, Explain>;

/** a table key - a typo here fails tsc instead of silently dropping the "?" */
export type ExplainId = keyof typeof SETTINGS_EXPLAIN;

/** one id open at a time, so every row in a screen shares one sheet. the
 *  sheet's title is the row's own label (handed back by onExplain), not the
 *  lookup id - ids are for the table key, never UI copy. */
export const useExplain = () => {
  const [open, setOpen] = useState<{ id: ExplainId; label: string } | null>(null);
  const explain = open ? SETTINGS_EXPLAIN[open.id] : undefined;
  return {
    /** spread onto a Row - a no-op when the id has no explain copy */
    explainProps: (explainId: ExplainId) =>
      SETTINGS_EXPLAIN[explainId]
        ? { onExplain: (label: string) => setOpen({ id: explainId, label }) }
        : {},
    sheet: open && explain && (
      <ExplainSheet title={open.label} explain={explain} onOpenChange={() => setOpen(null)} />
    ),
  };
};

export const ExplainSheet = ({
  title,
  explain,
  onOpenChange,
}: {
  title: string;
  explain: Explain;
  onOpenChange: (open: boolean) => void;
}) => (
  <Sheet open title={title} onOpenChange={onOpenChange}>
    <p className='text-sm leading-relaxed text-fg'>{explain.blurb}</p>
    {(explain.on != null || explain.off != null) && (
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
    )}
    {explain.states && (
      <div className='flex flex-col border border-surface-border-soft'>
        {explain.states.map((s, i) => (
          <div
            key={s.label}
            className={
              i === 0
                ? 'flex flex-col gap-0.5 px-3 py-2.5 text-xs leading-relaxed'
                : 'flex flex-col gap-0.5 border-t border-surface-border-soft px-3 py-2.5 text-xs leading-relaxed'
            }
          >
            <span className='text-fg-high lowercase'>{s.label}</span>
            <span className='text-fg-muted'>{s.text}</span>
          </div>
        ))}
      </div>
    )}
    {explain.footer && <span className='text-[11px] text-fg-dim'>{explain.footer}</span>}
  </Sheet>
);
