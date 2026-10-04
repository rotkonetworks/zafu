import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';
import { Watermark } from '@repo/ui/components/ui/watermark';
import { Mark } from '@repo/ui/components/ui/mark';

export const SettingsAbout = () => {
  return (
    <SettingsScreen title='about' backPath={PopupPath.SETTINGS}>
      <div className='relative isolate flex flex-col gap-4'>
        <Watermark glyph='道' corner='bottom-right' />
        <div>
          <Mark size={28} className='mb-2' />
          <span className='block text-label tracking-[0.18em] text-fg-muted lowercase'>
            shielded signing
          </span>
          <p className='text-xs text-fg-muted leading-relaxed mt-2'>
            privacy-first browser wallet for zcash and penumbra.
          </p>
          <p className='text-xs text-fg-muted mt-1'>
            version{' '}
            <span className='font-mono text-fg'>{chrome.runtime.getManifest().version}</span>
          </p>
        </div>

        <div>
          <h3 className='kicker mb-1'>networks</h3>
          <ul className='text-xs text-fg-muted space-y-0.5'>
            <li>zcash - shielded zec</li>
            <li>penumbra - private defi</li>
          </ul>
        </div>

        <div>
          <h3 className='kicker mb-1'>links</h3>
          <div className='flex flex-col gap-1.5'>
            <a
              href='https://zafu.pro'
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-1.5 text-xs text-zigner-gold hover:underline transition-colors'
            >
              <span className='i-ph-arrow-square-out h-3 w-3' />
              zafu.pro
            </a>
            <a
              href='https://github.com/rotkonetworks/zafu'
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-1.5 text-xs text-zigner-gold hover:underline transition-colors'
            >
              <span className='i-ph-arrow-square-out h-3 w-3' />
              github
            </a>
            <a
              href='https://zafu.pro/zigner'
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-1.5 text-xs text-zigner-gold hover:underline transition-colors'
            >
              <span className='i-ph-arrow-square-out h-3 w-3' />
              zigner cold wallet
            </a>
          </div>
        </div>

        <div className='border-t border-border-soft pt-3'>
          <p className='text-label text-fg-muted'>
            MIT license - built by{' '}
            <a
              href='https://rotko.net'
              target='_blank'
              rel='noopener noreferrer'
              className='text-zigner-gold hover:underline transition-colors'
            >
              rotko networks
            </a>
          </p>
        </div>
      </div>
    </SettingsScreen>
  );
};
