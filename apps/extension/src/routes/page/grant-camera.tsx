import { Button } from '@repo/ui/components/ui/button';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { cn } from '@repo/ui/lib/utils';
import { useState, useEffect } from 'react';
import { checkCameraPermission, requestCameraPermission } from '../../utils/popup-detection';

type PermissionState = 'checking' | 'not-granted' | 'requesting' | 'granted' | 'denied';

/**
 * Camera permission grant page (standalone full-page - popups can't trigger
 * the browser permission prompt). Lowercase voice, one tight line per state,
 * no Card wrapper. See apps/extension/DESIGN.md.
 */
const COPY: Record<PermissionState, { title: string; hint: string }> = {
  checking: { title: 'checking permission', hint: '' },
  'not-granted': {
    title: 'camera access',
    hint: 'zafu needs your camera to scan QR codes from your zigner.',
  },
  requesting: { title: 'requesting access', hint: 'allow camera access in the browser prompt.' },
  granted: { title: 'camera access granted', hint: 'close this tab and return to zafu.' },
  denied: {
    title: 'camera access denied',
    hint: 'enable it from the camera icon in your address bar, then try again.',
  },
};

export const GrantCamera = () => {
  const [state, setState] = useState<PermissionState>('checking');

  useEffect(() => {
    void checkCameraPermission().then(granted => setState(granted ? 'granted' : 'not-granted'));
  }, []);

  const handleGrantAccess = async () => {
    setState('requesting');
    const granted = await requestCameraPermission();
    setState(granted ? 'granted' : 'denied');
  };
  const handleClose = () => window.close();

  const { title, hint } = COPY[state];

  return (
    <FadeTransition>
      <div className='flex min-h-screen items-center justify-center p-8'>
        <div className='flex w-full max-w-sm flex-col items-center gap-6 text-center'>
          <div
            className={cn(
              'flex size-16 items-center justify-center rounded-full',
              state === 'granted'
                ? 'bg-green-500/15'
                : state === 'denied'
                  ? 'bg-red-500/15'
                  : 'bg-zigner-gold/15',
            )}
          >
            <span
              className={cn(
                'size-8',
                state === 'granted'
                  ? 'i-lucide-check-circle text-green-400'
                  : state === 'denied'
                    ? 'i-lucide-x text-red-400'
                    : 'i-lucide-camera text-zigner-gold',
              )}
            />
          </div>

          <div className='flex flex-col gap-1'>
            <h2 className='text-2xl lowercase tracking-[-0.01em] text-fg-high'>{title}</h2>
            {hint && <p className='text-xs lowercase text-fg-muted'>{hint}</p>}
          </div>

          <div className='flex w-full flex-col gap-2'>
            {state === 'not-granted' && (
              <Button
                variant='gradient'
                className='w-full'
                onClick={() => void handleGrantAccess()}
              >
                <span className='i-lucide-camera mr-2 size-4' />
                grant camera access
              </Button>
            )}
            {state === 'denied' && (
              <Button
                variant='secondary'
                className='w-full'
                onClick={() => void handleGrantAccess()}
              >
                try again
              </Button>
            )}
            {state === 'granted' && (
              <Button variant='gradient' className='w-full' onClick={handleClose}>
                close tab
              </Button>
            )}
            {(state === 'not-granted' || state === 'denied') && (
              <Button variant='ghost' className='w-full text-fg-muted' onClick={handleClose}>
                cancel
              </Button>
            )}
          </div>
        </div>
      </div>
    </FadeTransition>
  );
};
