import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';

export const SettingsAbout = () => {
  return (
    <SettingsScreen title='about' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4'>
        <div>
          <h3 className='kicker mb-1'>zafu wallet</h3>
          <p className='text-xs text-fg-muted leading-relaxed'>
            privacy-first browser wallet for penumbra, zcash, and cosmos IBC chains.
          </p>
          <p className='text-xs text-fg-muted mt-1'>
            version{' '}
            <span className='font-mono text-fg'>{chrome.runtime.getManifest().version}</span>
          </p>
        </div>

        <div>
          <h3 className='kicker mb-1'>networks</h3>
          <ul className='text-xs text-fg-muted space-y-0.5'>
            <li>zcash - orchard + ironwood shielded pools</li>
            <li>penumbra - shielded defi</li>
            <li>cosmos IBC - noble, cosmos hub</li>
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
              href='https://zigner.zafu.pro'
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
