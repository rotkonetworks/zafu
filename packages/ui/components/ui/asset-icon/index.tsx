import { useState } from 'react';
import { Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { Identicon } from '../identicon';
import { cn } from '../../../lib/utils';
import { DelegationTokenIcon } from './delegation-token-icon';
import { getDisplay } from '@penumbra-zone/getters/metadata';
import { assetPatterns } from '@rotko/penumbra-types/assets';
import { UnbondingTokenIcon } from './unbonding-token-icon';

export const AssetIcon = ({
  metadata,
  size = 'sm',
}: {
  metadata?: Metadata;
  size?: 'xs' | 'sm' | 'lg';
}) => {
  // a registry image URL can 404 or be blocked; fall back to a monogram tile.
  // Track the failed URL rather than a boolean, so switching to a different
  // asset (this component instance is reused across selections) re-attempts.
  const [failedSrc, setFailedSrc] = useState<string>();
  // Image default is "" and thus cannot do nullish-coalescing
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const icon = metadata?.images[0]?.png || metadata?.images[0]?.svg;
  const className = cn(
    'rounded-full',
    size === 'xs' && 'size-4',
    size === 'sm' && 'size-6',
    size === 'lg' && 'size-12',
  );
  const display = getDisplay.optional(metadata);
  const isDelegationToken = display ? assetPatterns.delegationToken.matches(display) : false;
  const isUnbondingToken = display ? assetPatterns.unbondingToken.matches(display) : false;

  return (
    <>
      {icon && failedSrc !== icon ? (
        <img
          className={className}
          src={icon}
          alt='Asset icon'
          onError={() => setFailedSrc(icon)}
        />
      ) : isDelegationToken ? (
        <DelegationTokenIcon displayDenom={display} className={className} />
      ) : isUnbondingToken ? (
        /**
         * @todo: Render a custom unbonding token for validators that have a
         * logo -- e.g., with the validator ID superimposed over the validator
         * logo.
         */
        <UnbondingTokenIcon displayDenom={display} className={className} />
      ) : (
        <Identicon
          uniqueIdentifier={metadata?.symbol ?? '?'}
          size={size === 'lg' ? 48 : size === 'sm' ? 24 : 16}
          type='solid'
        />
      )}
    </>
  );
};
