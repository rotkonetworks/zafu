import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';
import { NumeraireForm } from '../../../shared/components/numeraires-form';
import { useStore } from '../../../state';

/**
 * Numeraire pick - matches the onboarding language (shell pane + lowercase
 * question header + one tight subline), not the old standalone Card. The
 * privacy point (local pricing, no third-party feeds) is a single line, not
 * a paragraph.
 */
export const SetNumerairesPage = () => {
  const navigate = usePageNav();
  const chainId = useStore(state => state.network.chainId);

  const onSuccess = (): void => {
    navigate(PagePath.ONBOARDING_SUCCESS);
  };

  return (
    <FadeTransition>
      <div className='flex h-full flex-col gap-6'>
        <header className='flex flex-col gap-1'>
          <h2 className='text-2xl lowercase tracking-[-0.01em] text-fg-high'>
            how should assets be priced?
          </h2>
          <p className='text-xs lowercase text-fg-muted'>
            priced locally by denomination - never from a third-party feed.
          </p>
        </header>

        <NumeraireForm isOnboarding onSuccess={onSuccess} chainId={chainId} />
      </div>
    </FadeTransition>
  );
};
