/**
 * An icon for a registry entity (rpc, frontend, ibc chain, numeraire asset) -
 * never fetched from the network. A url the build bundled resolves to a
 * local image; anything else (the long tail of the registry) falls back to
 * a monogram tile, same as {@link AssetIcon}'s own fallback.
 */
import { Identicon } from '@repo/ui/components/ui/identicon';
import { resolveBundledIcon } from '@repo/ui/components/ui/asset-icon/bundled-icons';

export const RegistryIcon = ({
  name,
  images,
  className,
  size = 20,
}: {
  name: string;
  images?: { png?: string; svg?: string }[] | undefined;
  className?: string;
  size?: number;
}) => {
  const url = images?.[0]?.svg || images?.[0]?.png;
  const icon = url ? resolveBundledIcon(url) : undefined;
  return icon ? (
    <img src={icon} alt='' className={className} />
  ) : (
    <Identicon uniqueIdentifier={name || '?'} size={size} type='solid' className={className} />
  );
};
