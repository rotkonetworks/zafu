/**
 * segmented toggle at the top of the send / swap asset pickers: switch between
 * the default fungible "assets" list and the non-fungible "positions" list
 * (lp-position / auction NFTs).
 */
import { Segmented } from '@repo/ui/components/ui/segmented';

export type AssetBucket = 'assets' | 'positions';

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
    <Segmented
      label='asset bucket'
      value={bucket}
      onChange={onChange}
      options={[
        { value: 'assets', label: 'assets' },
        { value: 'positions', label: 'positions', meta: positionCount || undefined },
      ]}
    />
  );
}
