/**
 * segmented toggle at the top of the send / swap asset pickers: switch between
 * the default fungible "assets" list and the non-fungible "positions" list
 * (lp-position / auction NFTs). styling matches the shielded / transparent
 * toggle on the receive screen.
 */

export type AssetBucket = 'assets' | 'positions';

const BUCKETS: readonly AssetBucket[] = ['assets', 'positions'];

export function AssetBucketToggle({
  bucket,
  onChange,
  positionCount,
}: {
  bucket: AssetBucket;
  onChange: (bucket: AssetBucket) => void;
  /** shown next to the "positions" label when non-zero */
  positionCount?: number;
}) {
  return (
    <div className='flex w-full rounded-lg bg-elev-2 p-1'>
      {BUCKETS.map(b => (
        <button
          key={b}
          type='button'
          onClick={() => onChange(b)}
          className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
            bucket === b ? 'bg-canvas text-fg shadow-sm' : 'text-fg-muted hover:text-fg-high'
          }`}
        >
          {b}
          {b === 'positions' && positionCount ? ` (${positionCount})` : ''}
        </button>
      ))}
    </div>
  );
}
