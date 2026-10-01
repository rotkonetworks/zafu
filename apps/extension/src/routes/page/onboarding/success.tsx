/**
 * Wallet ready - Onb5Done board. The board's sync bar is left out: nothing
 * syncs until zafu is opened, and a bar here would be a made-up number.
 */

import { Button } from '@repo/ui/components/ui/button';
import { Mark } from '@repo/ui/components/ui/mark';

const openSidePanel = async () => {
  // The onboarding tab is itself an extension page (page.html). After we
  // open the side panel / popup, leaving this tab in place would leave the
  // user staring at the success screen wondering whether the wallet
  // actually opened. Close it once the new surface is up.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      // small grace period so the panel has fully attached before we tear
      // the tab down - without this, some Chrome builds race the panel's
      // initial paint and the user sees a blink instead of the wallet.
      setTimeout(() => window.close(), 250);
      return;
    }
  } catch {
    /* fall through to popup window fallback */
  }
  // side panel not supported or no active tab - fall back to popup
  await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 400,
    height: 628,
  });
  setTimeout(() => window.close(), 250);
};

export const OnboardingSuccess = () => (
  <div className='flex flex-col gap-[22px]'>
    <Mark variant='seal' glyph='済' size={76} className='-rotate-[7deg]' />
    <h1 className='font-display text-[44px] text-fg-high'>wallet ready</h1>

    <div className='flex flex-col gap-3 border border-border-soft bg-elev-1 p-[18px]'>
      <span className='text-data text-fg-high'>pin zafu to your toolbar</span>
      <div
        aria-hidden='true'
        className='flex h-11 items-center gap-3 border border-border-soft bg-canvas px-3'
      >
        <span className='h-2.5 flex-1 bg-elev-2' />
        <span className='grid size-[26px] place-items-center border border-border-hard'>
          <span className='i-ph-puzzle-piece size-3.5 text-fg-muted' />
        </span>
        <span className='i-lucide-arrow-right size-4 text-zigner-gold' />
        <Mark variant='seal' size={26} />
      </div>
      <span className='text-[11px] text-fg-muted'>extensions · then the pin next to zafu</span>
    </div>

    <Button autoFocus className='h-14 w-full text-[15px]' onClick={() => void openSidePanel()}>
      open zafu
    </Button>
  </div>
);
