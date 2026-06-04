/**
 * Onboarding completion — final step of the shell stepper.
 *
 * Removed the dense link-grid (poker / chat / dex / docs) that competed
 * for attention with the actual primary action ("open zafu"). A user
 * who just finished onboarding wants the single confidence: it worked,
 * here is the wallet. Discovery happens later from inside the wallet.
 */

import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { cn } from '@repo/ui/lib/utils';

const openSidePanel = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch {
    // side panel not supported or no active tab — fall back to popup
    await chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width: 400,
      height: 628,
    });
  }
};

export const OnboardingSuccess = () => {
  return (
    <FadeTransition>
      <div className='flex h-full flex-col items-center justify-center gap-7 py-6 text-center'>
        {/* tiny checkmark in a soft round badge — restrained */}
        <span className='inline-flex h-12 w-12 items-center justify-center rounded-full bg-zigner-gold/15'>
          <span className='i-lucide-check h-5 w-5 text-zigner-gold' />
        </span>

        <header className='flex flex-col gap-1'>
          <h2 className='text-2xl lowercase tracking-[-0.01em] text-fg-high'>wallet ready</h2>
          <p className='text-xs text-fg-muted lowercase tracking-[0.02em]'>
            shielded signing, on your terms.
          </p>
        </header>

        <button
          type='button'
          onClick={() => void openSidePanel()}
          className={cn(
            'group inline-flex items-center justify-center gap-2 px-6 py-3 text-sm lowercase tracking-[0.01em]',
            '[border-radius:14px] border border-zigner-gold/30 bg-zigner-gold/10 text-zigner-gold',
            'transition-[transform,background-color] duration-200',
            'hover:-translate-y-[1px] hover:bg-zigner-gold/15',
          )}
        >
          <span className='i-lucide-panel-right h-4 w-4' />
          open zafu
          <span className='i-lucide-arrow-right h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5' />
        </button>

        <p className='mt-2 max-w-xs text-[11px] text-fg-muted lowercase tracking-[0.02em]'>
          discover dapps and tools from inside the wallet once you're in.
        </p>
      </div>
    </FadeTransition>
  );
};
