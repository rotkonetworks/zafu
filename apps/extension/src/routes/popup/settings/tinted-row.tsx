/**
 * A screen row whose label carries a tone - Row's label is always
 * text-fg-high, so the "all ... controls" gold link and a danger link
 * (red) on a category home use this instead. Same shape as Row(type=
 * 'screen'), just with a colored label.
 */
export const TintedRow = ({
  label,
  tone,
  onPress,
}: {
  label: string;
  tone: 'gold' | 'danger';
  onPress: () => void;
}) => (
  <button
    type='button'
    onClick={onPress}
    className='flex min-h-[50px] w-full items-center gap-3 px-3.5 py-2 text-left transition-colors hover:bg-surface-elev-2'
  >
    <span
      className={`flex-1 text-sm lowercase ${tone === 'gold' ? 'text-zigner-gold' : 'text-hanko-light'}`}
    >
      {label}
    </span>
    <span className='i-ph-caret-right size-3.5 shrink-0 text-fg-dim' aria-hidden='true' />
  </button>
);
