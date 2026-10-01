import { Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { Identicon } from '../identicon';
import { cn } from '../../../lib/utils';
import { DelegationTokenIcon } from './delegation-token-icon';
import { getDisplay } from '@penumbra-zone/getters/metadata';
import { assetPatterns } from '@rotko/penumbra-types/assets';
import { UnbondingTokenIcon } from './unbonding-token-icon';
import { resolveBundledIcon } from './bundled-icons';

export const AssetIcon = ({
  metadata,
  size = 'sm',
}: {
  metadata?: Metadata;
  size?: 'xs' | 'sm' | 'lg';
}) => {
  // Image default is "" and thus cannot do nullish-coalescing
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const registryUrl = metadata?.images[0]?.png || metadata?.images[0]?.svg;
  // never fetched remotely: a url the app bundled resolves to a local asset,
  // anything else is "unknown" and falls through to the monogram below
  const icon = registryUrl ? resolveBundledIcon(registryUrl) : undefined;
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
      {icon ? (
        <img className={className} src={icon} alt='Asset icon' />
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
