/**
 * password gate modal - requires password confirmation before transactions
 *
 * mnemonic wallets: password input + verify
 * zigner wallets: informational (QR auth happens in approval popup)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { EyeClosedIcon, EyeOpenIcon, LockClosedIcon } from '@radix-ui/react-icons';
import { useStore } from '../../state';
import { passwordSelector } from '../../state/password';

interface PasswordGateModalProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** 'zigner' shows informational message only */
  walletType?: 'mnemonic' | 'zigner';
}

export const PasswordGateModal = ({
  open,
  onConfirm,
  onCancel,
  walletType = 'mnemonic',
}: PasswordGateModalProps) => {
  const { isPassword } = useStore(passwordSelector);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [reveal, setReveal] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // auto-focus and reset on open
  useEffect(() => {
    if (open) {
      setPassword('');
      setError('');
      setChecking(false);
      setReveal(false);
      // delay focus to after render
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSubmit = useCallback(async () => {
    if (!password.trim()) {
      setError('password required');
      return;
    }

    setChecking(true);
    setError('');

    try {
      const valid = await isPassword(password);
      if (valid) {
        onConfirm();
      } else {
        setError('wrong password');
        setPassword('');
        inputRef.current?.focus();
      }
    } catch {
      setError('verification failed');
    } finally {
      setChecking(false);
    }
  }, [password, isPassword, onConfirm]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        void handleSubmit();
      } else if (e.key === 'Escape') {
        onCancel();
      }
    },
    [handleSubmit, onCancel],
  );

  if (!open) return null;

  return (
    <div className='fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm'>
      <div className='mx-4 w-full max-w-sm rounded-lg border border-border bg-background p-5 shadow-2xl'>
        <div className='mb-4 flex items-center gap-2'>
          <LockClosedIcon className='h-4 w-4 text-primary' />
          <h3 className='text-sm font-medium'>Confirm Transaction</h3>
        </div>

        {walletType === 'zigner' ? (
          <>
            <p className='mb-4 text-xs text-muted-foreground'>
              This transaction requires authorization from your Zigner device.
            </p>
            <div className='flex gap-2'>
              <button
                onClick={onConfirm}
                className='flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90'
              >
                Continue
              </button>
              <button
                onClick={onCancel}
                className='flex-1 rounded-lg border border-border px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50'
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p className='mb-3 text-xs text-muted-foreground'>
              Enter your password to authorize this transaction.
            </p>

            <div className='relative mb-3'>
              <input
                ref={inputRef}
                type={reveal ? 'text' : 'password'}
                value={password}
                onChange={e => {
                  setPassword(e.target.value);
                  setError('');
                }}
                onKeyDown={handleKeyDown}
                placeholder='password'
                disabled={checking}
                className='w-full rounded-lg border border-border bg-input px-3 py-2.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none disabled:opacity-50'
              />
              <button
                type='button'
                onClick={() => setReveal(prev => !prev)}
                className='absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground'
              >
                {reveal ? (
                  <EyeOpenIcon className='h-3.5 w-3.5' />
                ) : (
                  <EyeClosedIcon className='h-3.5 w-3.5' />
                )}
              </button>
            </div>

            {error && (
              <p className='mb-3 text-xs text-red-400'>{error}</p>
            )}

            <div className='flex gap-2'>
              <button
                onClick={() => void handleSubmit()}
                disabled={checking || !password.trim()}
                className='flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50'
              >
                {checking ? 'verifying...' : 'Confirm'}
              </button>
              <button
                onClick={onCancel}
                disabled={checking}
                className='flex-1 rounded-lg border border-border px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 disabled:opacity-50'
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
