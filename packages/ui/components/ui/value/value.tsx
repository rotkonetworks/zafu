import { Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { AssetIcon } from '../asset-icon';
import { Pill } from '../pill';
import { cn } from '../../../lib/utils';
import { assetPatterns } from '@rotko/penumbra-types/assets';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTrigger,
  DialogTitle,
  DialogDescription,
} from '../dialog';

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
}

const UnbondingDialogContent = ({
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
    <div className='flex flex-col gap-3 p-4'>
      <div>
        <span className='text-muted-foreground text-sm'>Started at block</span>
        <div className='text-white font-mono'>{info.startAt.toLocaleString()}</div>
      </div>
      <div>
        <span className='text-muted-foreground text-sm'>Claimable at block</span>
        <div className='text-white font-mono'>{info.claimableAt.toLocaleString()}</div>
      </div>
      {currentBlockHeight !== undefined && blocksRemaining !== undefined && (
        <div>
          <span className='text-muted-foreground text-sm'>Current block</span>
          <div className='text-white font-mono'>{currentBlockHeight.toLocaleString()}</div>
          {blocksRemaining === 0 ? (
            <div className='text-green-400 text-sm mt-1'>Ready to claim!</div>
          ) : (
            <div className='text-orange-400 text-sm mt-1'>
              {blocksRemaining.toLocaleString()} blocks remaining ({formatDuration(blocksRemaining)})
            </div>
          )}
        </div>
      )}
      <div>
        <span className='text-muted-foreground text-sm'>Validator</span>
        <div className='text-white break-all text-xs font-mono'>{info.validatorId}</div>
      </div>
      <a
        href={UNBONDING_DOCS_URL}
        target='_blank'
        rel='noopener noreferrer'
        className='text-xs text-teal hover:underline mt-2'
      >
        Learn more about unbonding delay
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
}: ValueComponentProps) => {
  const unbondingInfo = parseUnbondingToken(metadata);

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
      <Dialog>
        <DialogTrigger asChild>
          <button type='button' className='cursor-pointer'>
            {content}
          </button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>Unbonding Token</DialogHeader>
          <DialogTitle className='sr-only'>Unbonding Token Details</DialogTitle>
          <DialogDescription className='sr-only'>
            Information about this unbonding token including start block, claimable block, and validator.
          </DialogDescription>
          <UnbondingDialogContent info={unbondingInfo} currentBlockHeight={currentBlockHeight} />
        </DialogContent>
      </Dialog>
    );
  }

  return content;
};
