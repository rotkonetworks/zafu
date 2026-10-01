/**
 * No wallet yet - the Welcome board, in the popup or side panel. Each way in
 * opens the full-tab onboarding at its first step, reusing a tab that is
 * already showing it.
 */

import { Button } from '@repo/ui/components/ui/button';
import { Mark } from '@repo/ui/components/ui/mark';
import { PagePath } from '../page/paths';

const ART_FADE = {
  maskImage:
    'linear-gradient(to bottom, #000 calc(100% - 150px), rgb(0 0 0 / 0.15) 90%, transparent)',
};

const openOnboarding = async (path: PagePath) => {
  const url = chrome.runtime.getURL(`page.html#${path}`);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.TAB],
  });
  const open = contexts.find(c => c.documentUrl?.includes('/page.html'));
  if (open && open.tabId >= 0) {
    await chrome.tabs.update(open.tabId, { url, active: true });
    await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
};

const go = (path: PagePath) => () => void openOnboarding(path);

export const PopupWelcome = () => (
  <div className='flex h-full min-h-[628px] flex-col bg-canvas text-fg'>
    <div className='relative h-[330px] shrink-0 overflow-hidden'>
      <img
        src='/media/welcome.webp'
        alt='a samurai sits on a zafu cushion beside an ink and gold enso'
        style={ART_FADE}
        className='absolute inset-0 h-full w-full object-cover object-[38%_40%]'
      />
    </div>

    <div className='relative -mt-[34px] flex flex-1 flex-col gap-3 px-7'>
      <Mark size={34} />
      <span className='-mt-1.5 ml-[46px] text-[11px] tracking-[0.1em] text-fg-muted'>
        shielded signing
      </span>
      <h1 className='font-display text-[28px] leading-[1.25] text-fg-high'>
        held in your own hands,
        <br />
        seen by no one.
      </h1>
      <p className='text-label tracking-[0.04em] text-fg-muted'>
        zcash · penumbra · private by default
      </p>
    </div>

    <div className='flex flex-col gap-2.5 px-5 pb-[18px]'>
      <Button autoFocus className='w-full' onClick={go(PagePath.CREATE_PASSWORD)}>
        create wallet
      </Button>
      <Button variant='secondary' className='w-full' onClick={go(PagePath.IMPORT_SEED_PHRASE)}>
        import recovery phrase
      </Button>
      <div className='flex h-9 items-center justify-center gap-[18px] text-label text-fg-muted'>
        <button
          type='button'
          onClick={go(PagePath.IMPORT_ZIGNER)}
          className='flex items-center gap-1.5 bg-transparent transition-colors hover:text-fg-high'
        >
          <span className='i-zafu-hanko size-[15px]' aria-hidden='true' />
          connect zigner
        </button>
        <span className='h-3 w-px bg-border-hard' aria-hidden='true' />
        <button
          type='button'
          onClick={go(PagePath.CHOOSE)}
          className='bg-transparent transition-colors hover:text-fg-high'
        >
          ledger / keystone
        </button>
      </div>
    </div>
  </div>
);
