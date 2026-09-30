import { cn } from '@repo/ui/lib/utils';

/** amber, dismissible backup reminder - gone forever once confirmed */
export const BackupNudge = ({ onBackUp, onDismiss }: { onBackUp: () => void; onDismiss: () => void }) => (
  <div className='flex items-center gap-2.5 rounded-md border border-warning/30 bg-warning/[0.07] px-3 py-2.5'>
    <span className='i-ph-warning h-4 w-4 shrink-0 text-warning' />
    <span className='flex-1 text-label text-fg lowercase'>recovery phrase not backed up</span>
    <button
      onClick={onBackUp}
      className='shrink-0 text-label text-warning lowercase underline-offset-2 hover:underline'
    >
      back up
    </button>
    <button
      onClick={onDismiss}
      title='I already backed it up'
      className='shrink-0 p-0.5 text-fg-dim transition-colors hover:text-fg-high'
    >
      <span className='i-ph-x h-3.5 w-3.5' />
    </button>
  </div>
);


/**
 * Icon-forward action button for the home action row (receive / swap /
 * send). Graphical at rest - just the icon, evenly spaced in a 3-column
 * grid under the balance - with the text label revealed on hover
 * (hover-expand plus a title tooltip). Zashi's few-big-obvious-actions,
 * without permanent text clutter.
 *
 * Variants:
 *   - default: subdued elev-2 background
 *   - zcash:   zigner-gold (primary outgoing action)
 *   - penumbra:penumbra-purple (primary outgoing action on penumbra)
 */
export const ActionButton = ({
  icon,
  label,
  onClick,
  variant = 'default',
}: {
  icon: string;
  label: string;
  onClick: () => void;
  variant?: 'default' | 'zcash' | 'penumbra';
}) => (
  <button
    type='button'
    onClick={onClick}
    title={label}
    aria-label={label}
    className={cn(
      'group/action flex h-11 w-full items-center justify-center rounded-md px-3 transition-colors',
      variant === 'default' && 'bg-elev-2 text-fg hover:bg-elev-1/80 hover:text-fg-high',
      variant === 'zcash' && 'bg-zigner-gold text-zigner-gold-foreground hover:bg-primary/90',
      // Same treatment as zcash: solid accent, dark foreground. It was a
      // raw orange->teal gradient with white text, which bypassed the
      // network-accent tokens entirely - so the one control the eye lands on
      // was the only thing on the screen not wearing the theme, and white on
      // a light teal is the weakest contrast in the app besides.
      //
      // --network-accent-foreground is #0a0a0a under both networks, so this
      // is the same relationship zcash has: dark on the chain's colour.
      variant === 'penumbra' &&
        'bg-network-accent text-network-accent-foreground hover:opacity-90 transition-opacity',
    )}
  >
    <span className={`${icon} h-5 w-5 shrink-0`} />
    <span className='max-w-0 overflow-hidden text-label lowercase leading-none tracking-[0.05em] whitespace-nowrap opacity-0 transition-all duration-200 group-hover/action:ml-2 group-hover/action:max-w-16 group-hover/action:opacity-100'>
      {label}
    </span>
  </button>
);

/**
 * First-sync reassurance - one of the message-slot candidates. Shown only
 * while actively syncing with no balance yet (the canonical new-user
 * state) so the user doesn't think the wallet is broken.
 */


/**
 * Empty-balance hint shown to a new user whose wallet is synced but
 * holds zero ZEC. Two concrete next steps so the wallet doesn't feel
 * like a dead end: receive (here's your address) and exchanges (where
 * to buy). A swap path was removed — the swap button sits directly
 * above this panel, and Penumbra DEX has no ZEC liquidity yet so the
 * old copy over-promised.
 *
 * Dismissable in the sense that any inbound ZEC makes the panel
 * disappear naturally — there is no manual hide because the panel is
 * informational and we want to nudge action.
 */
export const GetZecHint = ({ onReceive }: { onReceive: () => void }) => (
  <div className='rounded-md border border-network-accent/15 bg-elev-1 p-4'>
    <div className='mb-3 flex items-center gap-2'>
      <span className='i-ph-sparkle h-3.5 w-3.5 text-network-accent' />
      <span className='text-xs font-medium text-fg-high'>get your first zec</span>
    </div>

    <div className='flex flex-col gap-2'>
      <HintRow
        icon='i-ph-arrow-line-down'
        title='receive from someone'
        hint='share your shielded address — works for any zec sender'
        onClick={onReceive}
      />
      <a
        href='https://z.cash/get-started/'
        target='_blank'
        rel='noopener noreferrer'
        className='group flex items-start gap-3 rounded-sm bg-elev-2/40 p-2.5 text-left transition-colors hover:bg-elev-2/60'
      >
        <span className='mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center bg-network-accent/10 text-network-accent'>
          <span className='i-ph-shopping-bag h-3.5 w-3.5' />
        </span>
        <span className='flex flex-1 flex-col'>
          <span className='text-xs lowercase text-fg-high'>buy at an exchange</span>
          <span className='mt-0.5 text-label text-fg-muted lowercase'>
            z.cash list of supported exchanges
          </span>
        </span>
        <span className='i-ph-arrow-square-out mt-1 h-3 w-3 shrink-0 text-fg-muted transition-colors group-hover:text-fg-high' />
      </a>
    </div>
  </div>
);


export const HintRow = ({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: string;
  title: string;
  hint: string;
  onClick: () => void;
}) => (
  <button
    type='button'
    onClick={onClick}
    className='group flex items-start gap-3 bg-elev-2/40 p-2.5 text-left transition-colors hover:bg-elev-2/60'
  >
    <span className='mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center bg-network-accent/10 text-network-accent'>
      <span className={`${icon} h-3.5 w-3.5`} />
    </span>
    <span className='flex flex-1 flex-col'>
      <span className='text-xs lowercase text-fg-high'>{title}</span>
      <span className='mt-0.5 text-label text-fg-muted lowercase'>{hint}</span>
    </span>
    <span className='i-ph-arrow-right mt-1 h-3 w-3 shrink-0 text-fg-muted transition-transform duration-200 group-hover:translate-x-0.5' />
  </button>
);

