import { Button } from '@repo/ui/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@repo/ui/components/ui/card';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { cn } from '@repo/ui/lib/utils';
import { CameraIcon, CheckCircledIcon, Cross1Icon } from '@radix-ui/react-icons';
import { useState, useEffect } from 'react';
import {
  checkCameraPermission,
  requestCameraPermission,
} from '../../utils/popup-detection';

type PermissionState = 'checking' | 'not-granted' | 'requesting' | 'granted' | 'denied';

/**
 * Camera permission grant page.
 *
 * This page is opened from the popup when camera permission is needed.
 * Extension popups cannot trigger browser permission prompts, so we need
 * to open this full page to request camera access.
 *
 * After granting, user is instructed to return to the extension popup.
 */
export const GrantCamera = () => {
  const [state, setState] = useState<PermissionState>('checking');

  // Check current permission status on mount
  useEffect(() => {
    void checkCameraPermission().then(granted => {
      setState(granted ? 'granted' : 'not-granted');
    });
  }, []);

  const handleGrantAccess = async () => {
    setState('requesting');
    const granted = await requestCameraPermission();
    setState(granted ? 'granted' : 'denied');
  };

  const handleClose = () => {
    window.close();
  };

  return (
    <FadeTransition>
      <div className='flex min-h-screen items-center justify-center p-8'>
        <Card className={cn('p-6', 'w-[500px]')} gradient>
          <CardHeader className='items-center'>
            <div className={cn(
              'rounded-full p-4 mb-2',
              state === 'granted' ? 'bg-green-500/20' : 'bg-primary/20'
            )}>
              {state === 'granted' ? (
                <CheckCircledIcon className='size-10 text-green-500' />
              ) : state === 'denied' ? (
                <Cross1Icon className='size-10 text-red-400' />
              ) : (
                <CameraIcon className='size-10 text-primary' />
              )}
            </div>
            <CardTitle className='font-semibold text-xl'>
              {state === 'granted' && 'Camera Access Granted'}
              {state === 'denied' && 'Camera Access Denied'}
              {state === 'checking' && 'Checking Permission...'}
              {state === 'not-granted' && 'Camera Permission Required'}
              {state === 'requesting' && 'Requesting Access...'}
            </CardTitle>
            <CardDescription className='text-center mt-2'>
              {state === 'granted' && (
                <>
                  <p>You can now scan QR codes in the Prax extension.</p>
                  <p className='mt-2 font-medium text-foreground'>
                    Close this tab and return to the extension popup.
                  </p>
                </>
              )}
              {state === 'denied' && (
                <>
                  <p>Camera access was denied.</p>
                  <p className='mt-2'>
                    To enable camera access, click the camera icon in your browser's
                    address bar or check your browser settings.
                  </p>
                </>
              )}
              {state === 'not-granted' && (
                <>
                  <p>
                    Prax needs camera access to scan QR codes from your Zigner device.
                  </p>
                  <p className='mt-2 text-muted-foreground text-sm'>
                    Click the button below to grant access. Your browser will show
                    a permission prompt.
                  </p>
                </>
              )}
              {state === 'requesting' && (
                <p>Please allow camera access in the browser prompt...</p>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className='flex flex-col gap-3'>
              {state === 'not-granted' && (
                <Button
                  variant='gradient'
                  className='w-full'
                  onClick={handleGrantAccess}
                >
                  <CameraIcon className='size-5 mr-2' />
                  Grant Camera Access
                </Button>
              )}

              {state === 'denied' && (
                <Button
                  variant='secondary'
                  className='w-full'
                  onClick={handleGrantAccess}
                >
                  Try Again
                </Button>
              )}

              {state === 'granted' && (
                <Button
                  variant='gradient'
                  className='w-full'
                  onClick={handleClose}
                >
                  Close Tab
                </Button>
              )}

              {(state === 'not-granted' || state === 'denied') && (
                <Button
                  variant='ghost'
                  className='w-full text-muted-foreground'
                  onClick={handleClose}
                >
                  Cancel
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </FadeTransition>
  );
};
