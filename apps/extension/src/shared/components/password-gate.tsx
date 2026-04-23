/**
 * password gate modal - requires password confirmation before transactions
 *
 * mnemonic wallets: password input + verify
 * zigner wallets: informational (QR auth happens in approval popup)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
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
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm'>
      <div className='mx-4 w-full max-w-sm rounded-lg border border-border-soft bg-canvas p-5 shadow-xl'>
        <div className='mb-4 flex items-center gap-2'>
          <span className='i-lucide-lock h-4 w-4 text-zigner-gold' />
          <h3 className='text-lg font-medium'>Confirm Transaction</h3>
        </div>

        {walletType === 'zigner' ? (
          <>
            <p className='mb-4 text-xs text-fg-muted'>
              This transaction requires authorization from your Zigner device.
            </p>
            <div className='flex gap-2'>
              <button
                onClick={onCancel}
                className='flex-1 rounded-lg border border-border-soft px-4 py-3 text-sm text-fg-muted transition-colors hover:bg-elev-1'
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                className='flex-1 rounded-lg bg-zigner-gold px-4 py-3 text-sm font-medium text-zigner-dark transition-colors hover:bg-primary/90'
              >
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <p className='mb-3 text-xs text-fg-muted'>
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
                className='w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 pr-10 text-sm text-fg placeholder:text-fg-muted focus:border-zigner-gold focus:outline-none disabled:opacity-50'
              />
              <button
                type='button'
                onClick={() => setReveal(prev => !prev)}
                className='absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg-high'
              >
                {reveal ? (
                  <span className='i-lucide-eye h-3.5 w-3.5' />
                ) : (
                  <span className='i-lucide-eye-off h-3.5 w-3.5' />
                )}
              </button>
            </div>

            {error && (
              <p className='mb-3 text-xs text-red-400'>{error}</p>
            )}

            <div className='flex gap-2'>
              <button
                onClick={onCancel}
                disabled={checking}
                className='flex-1 rounded-lg border border-border-soft px-4 py-3 text-sm text-fg-muted transition-colors hover:bg-elev-1 disabled:opacity-50'
              >
                Cancel
              </button>
              <button
                onClick={() => void handleSubmit()}
                disabled={checking || !password.trim()}
                className='flex-1 rounded-lg bg-zigner-gold px-4 py-3 text-sm font-medium text-zigner-dark transition-colors hover:bg-primary/90 disabled:opacity-50'
              >
                {checking ? 'verifying...' : 'Confirm'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
