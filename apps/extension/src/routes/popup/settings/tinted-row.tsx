/**
 * A screen row whose label carries danger tone - Row's label is always
 * text-fg-high, so a destructive link ("remove wallet", "turn off ...")
 * uses this instead. Same shape as Row(type='screen'), just red.
 */
export const TintedRow = ({ label, onPress }: { label: string; onPress: () => void }) => (
  <button
    type='button'
    onClick={onPress}
    className='flex min-h-[50px] w-full items-center gap-3 px-3.5 py-2 text-left transition-colors hover:bg-surface-elev-2'
  >
    <span className='flex-1 text-sm lowercase text-hanko'>{label}</span>
    <span className='i-ph-caret-right size-3.5 shrink-0 text-fg-dim' aria-hidden='true' />
  </button>
);
