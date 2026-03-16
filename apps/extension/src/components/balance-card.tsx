import { ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';

interface ActionButton {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

interface BalanceCardProps {
  totalBalance: string;
  balanceLabel?: string;
  isLoading?: boolean;
  isPrivacyMode?: boolean;
  onTogglePrivacy?: () => void;
  actions?: ActionButton[];
  className?: string;
}

export const BalanceCard = ({
  totalBalance,
  balanceLabel = 'Total Balance',
  isLoading = false,
  isPrivacyMode = false,
  onTogglePrivacy,
  actions,
  className,
}: BalanceCardProps) => {
  const defaultActions: ActionButton[] = [
    {
      icon: <span className='i-lucide-arrow-down h-4 w-4' />,
      label: 'Receive',
      onClick: () => {},
    },
    {
      icon: <span className='i-lucide-arrow-up h-4 w-4' />,
      label: 'Send',
      onClick: () => {},
    },
    {
      icon: <span className='i-lucide-refresh-cw h-4 w-4' />,
      label: 'Swap',
      onClick: () => {},
    },
  ];

  const displayActions = actions || defaultActions;

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border border-border/40 bg-gradient-to-br from-card to-card/80 p-5',
        className
      )}
    >
      {/* Balance Section */}
      <div className='mb-6'>
        <div className='flex items-center justify-between'>
          <span className='text-sm text-muted-foreground'>{balanceLabel}</span>
          {onTogglePrivacy && (
            <button
              onClick={onTogglePrivacy}
              className='rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
            >
              {isPrivacyMode ? (
                <span className='i-lucide-eye-off h-4 w-4' />
              ) : (
                <span className='i-lucide-eye h-4 w-4' />
              )}
            </button>
          )}
        </div>
        <div className='mt-1'>
          {isLoading ? (
            <div className='h-9 w-32 animate-pulse rounded-md bg-muted' />
          ) : (
            <span className='text-3xl font-medium tracking-tight'>
              {isPrivacyMode ? '••••••' : totalBalance}
            </span>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className='grid grid-cols-3 gap-2'>
        {displayActions.map((action, idx) => (
          <Button
            key={idx}
            variant='secondary'
            size='sm'
            onClick={action.onClick}
            disabled={action.disabled}
            className='flex flex-col items-center gap-1 py-3'
          >
            {action.icon}
            <span className='text-xs'>{action.label}</span>
          </Button>
        ))}
      </div>

      {/* Decorative gradient */}
      <div className='pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-primary/10 blur-3xl' />
    </div>
  );
};
