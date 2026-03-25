import { FadeTransition } from '@repo/ui/components/ui/fade-transition';

const openSidePanel = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch {
    // side panel not supported or no active tab - fall back to popup
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
      <div className='flex flex-col items-center gap-6 max-w-lg mx-auto pt-12'>
        <span className='i-lucide-check-circle h-16 w-16 text-green-500' />
        <h1 className='text-2xl font-medium'>wallet ready</h1>

        {/* primary action */}
        <button
          onClick={() => void openSidePanel()}
          className='w-full max-w-xs flex items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors'
        >
          <span className='i-lucide-panel-right h-4 w-4' />
          open zafu
        </button>

        {/* links */}
        <div className='grid grid-cols-2 gap-3 w-full mt-2'>
          <a
            href='https://poker.zk.bot'
            target='_blank'
            rel='noopener noreferrer'
            className='flex flex-col items-center gap-2 rounded-lg border border-border/40 bg-card p-4 hover:bg-muted/50 transition-colors'
          >
            <span className='i-lucide-spade h-5 w-5 text-muted-foreground' />
            <span className='text-xs'>play poker</span>
          </a>
          <a
            href={chrome.runtime.getURL('zitadel.html')}
            className='flex flex-col items-center gap-2 rounded-lg border border-border/40 bg-card p-4 hover:bg-muted/50 transition-colors'
          >
            <span className='i-lucide-message-circle h-5 w-5 text-muted-foreground' />
            <span className='text-xs'>chat</span>
          </a>
          <a
            href='https://dex.penumbra.zone'
            target='_blank'
            rel='noopener noreferrer'
            className='flex flex-col items-center gap-2 rounded-lg border border-border/40 bg-card p-4 hover:bg-muted/50 transition-colors'
          >
            <span className='i-lucide-arrow-left-right h-5 w-5 text-muted-foreground' />
            <span className='text-xs'>trade with penumbra dex</span>
          </a>
          <a
            href={chrome.runtime.getURL('docs/index.html')}
            className='flex flex-col items-center gap-2 rounded-lg border border-border/40 bg-card p-4 hover:bg-muted/50 transition-colors'
          >
            <span className='i-lucide-book-open h-5 w-5 text-muted-foreground' />
            <span className='text-xs'>docs</span>
          </a>
        </div>

        <div className='flex items-center gap-4 text-[10px] text-muted-foreground'>
          <a href='https://rotko.net' target='_blank' rel='noopener noreferrer' className='hover:text-foreground'>rotko.net</a>
          <a href='https://zigner.rotko.net' target='_blank' rel='noopener noreferrer' className='hover:text-foreground'>zigner</a>
        </div>
      </div>
    </FadeTransition>
  );
};
