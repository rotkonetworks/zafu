/**
 * Onboarding completion - Onb5Done board. One confidence, one action: it
 * worked, here is the wallet. Discovery happens later from inside it.
 */

import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { Button } from '@repo/ui/components/ui/button';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { Mark } from '@repo/ui/components/ui/mark';
import { OnboardingShell } from './onboarding-shell';

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

export const OnboardingSuccess = () => {
  return (
    <OnboardingShell art='castle'>
      <FadeTransition>
        <div className='flex flex-col gap-[22px]'>
          <Mark variant='seal' glyph='済' size={76} className='-rotate-[7deg]' />
          <h1 className='font-display text-[44px] text-fg-high'>wallet ready</h1>

          <Button
            variant='primary'
            className='h-14 w-full text-body'
            onClick={() => void openSidePanel()}
          >
            open zafu
          </Button>

          <StatusSlot tone='info' icon='i-ph-shield-check'>
            shielded signing, on your terms. syncing continues in the background - you can use zafu
            now.
          </StatusSlot>
        </div>
      </FadeTransition>
    </OnboardingShell>
  );
};
