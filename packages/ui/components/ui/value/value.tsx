import { Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { AssetIcon } from '../asset-icon';
import { Pill } from '../pill';
import { cn } from '../../../lib/utils';
import { assetPatterns } from '@rotko/penumbra-types/assets';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip';

const UNBONDING_DELAY_BLOCKS = 120_960;
const SECONDS_PER_BLOCK = 5;
const UNBONDING_DOCS_URL = 'https://guide.penumbra.zone/overview/staking#unbonding-delay';

const formatDuration = (blocks: number): string => {
  const totalSeconds = blocks * SECONDS_PER_BLOCK;
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);

  if (days > 0) {
    return hours > 0 ? `~${days}d ${hours}h` : `~${days} days`;
  }
  return `~${hours} hours`;
};

interface UnbondingInfo {
  startAt: number;
  claimableAt: number;
  validatorId: string;
  validatorName?: string;
}

const parseUnbondingToken = (metadata?: Metadata): UnbondingInfo | null => {
  const display = metadata?.display;
  if (!display) return null;

  const captured = assetPatterns.unbondingToken.capture(display);
  if (!captured) return null;

  const startAt = parseInt(captured.startAt, 10);
  return {
    startAt,
    claimableAt: startAt + UNBONDING_DELAY_BLOCKS,
    validatorId: captured.idKey,
  };
};

interface ValueComponentProps {
  formattedAmount: string;
  symbol: string;
  metadata?: Metadata;
  variant: 'default' | 'equivalent';
  showIcon: boolean;
  showValue: boolean;
  showDenom: boolean;
  size: 'default' | 'sm';
  currentBlockHeight?: number;
  validatorName?: string;
}

const UnbondingTooltipContent = ({
  info,
  currentBlockHeight,
}: {
  info: UnbondingInfo;
  currentBlockHeight?: number;
}) => {
  const blocksRemaining = currentBlockHeight !== undefined
    ? Math.max(0, info.claimableAt - currentBlockHeight)
    : undefined;

  return (
    <div className='flex flex-col gap-2 font-normal text-left'>
      <div className='font-bold text-white'>Unbonding Token</div>
      <div>
        <span className='text-muted-foreground'>Start: </span>
        <span className='text-white font-mono'>{info.startAt.toLocaleString()}</span>
      </div>
      <div>
        <span className='text-muted-foreground'>End: </span>
        <span className='text-white font-mono'>{info.claimableAt.toLocaleString()}</span>
      </div>
      {currentBlockHeight !== undefined && blocksRemaining !== undefined && (
        <div>
          <span className='text-muted-foreground'>Current: </span>
          <span className='text-white font-mono'>{currentBlockHeight.toLocaleString()}</span>
          {blocksRemaining === 0 ? (
            <span className='text-green-400 ml-2'>Ready!</span>
          ) : (
            <div className='text-orange-400 text-xs mt-1'>
              {blocksRemaining.toLocaleString()} blocks ({formatDuration(blocksRemaining)})
            </div>
          )}
        </div>
      )}
      <div>
        <span className='text-muted-foreground'>Validator: </span>
        {info.validatorName && (
          <div className='text-white font-medium'>{info.validatorName}</div>
        )}
        <div className='text-white break-all text-[10px] font-mono'>{info.validatorId}</div>
      </div>
      <a
        href={UNBONDING_DOCS_URL}
        target='_blank'
        rel='noopener noreferrer'
        className='text-[10px] text-teal hover:underline'
      >
        Learn more
      </a>
    </div>
  );
};

export const ValueComponent = ({
  formattedAmount,
  symbol,
  metadata,
  variant,
  showIcon,
  showValue,
  showDenom,
  size,
  currentBlockHeight,
  validatorName,
}: ValueComponentProps) => {
  const parsed = parseUnbondingToken(metadata);
  const unbondingInfo = parsed ? { ...parsed, validatorName } : null;

  const content = (
    <Pill variant={variant === 'default' ? 'default' : 'dashed'}>
      <div className='flex min-w-0 items-center gap-1'>
        {showIcon && (
          <div className='-ml-2 mr-1 flex shrink-0 items-center justify-center rounded-full'>
            <AssetIcon metadata={metadata} size={size === 'default' ? 'sm' : 'xs'} />
          </div>
        )}
        {showValue && (
          <span className={cn('-mb-0.5 text-nowrap leading-[15px]', size === 'sm' && 'text-xs')}>
            {variant === 'equivalent' && <>~ </>}
            {formattedAmount}
          </span>
        )}
        {showDenom && (
          <span
            className={cn(
              symbol.startsWith('delUM') ? 'max-w-[40px]' : 'max-w-[80px]',
              'truncate font-mono text-xs text-muted-foreground',
            )}
            title={symbol}
          >
            {symbol}
          </span>
        )}
      </div>
    </Pill>
  );

  if (unbondingInfo) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type='button' className='cursor-pointer'>
              {content}
            </button>
          </TooltipTrigger>
          <TooltipContent side='top' sideOffset={8} className='max-w-[280px]'>
            <UnbondingTooltipContent info={unbondingInfo} currentBlockHeight={currentBlockHeight} />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return content;
};
