/**
 * A dapp's identity, without ever fetching its favicon: the origin's first
 * letter on a tile whose colour is seeded from the origin, generated
 * locally. Replaces the raw `<img src={favIconUrl}>` in every approval
 * header and connected-site row - a remote host should never learn which of
 * its pages a wallet is looking at just from an icon request.
 *
 * Reuses {@link Identicon} (the same monogram tile asset icons fall back to
 * when a registry image is blocked or missing), seeded by hostname so the
 * same site always gets the same tile.
 */

import { Identicon } from '@repo/ui/components/ui/identicon';

const hostnameOf = (origin: string): string => {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
};

export const OriginIcon = ({
  origin,
  size = 32,
  className,
}: {
  origin: string;
  size?: number;
  className?: string;
}) => {
  const host = hostnameOf(origin);
  return (
    <Identicon
      type='solid'
      uniqueIdentifier={host || '?'}
      size={size}
      {...(className ? { className } : {})}
    />
  );
};
