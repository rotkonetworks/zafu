/**
 * password gate modal - requires password confirmation before transactions.
 * device wallets never see it: their own review and qr confirm.
 */

import {
  Dialog,
  DialogLayer,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@repo/ui/components/ui/dialog';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../../state';
import { passwordSelector } from '../../state/password';

interface PasswordGateModalProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const PasswordGateModal = ({ open, onConfirm, onCancel }: PasswordGateModalProps) => {
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
      setError('please enter your password');
      return;
    }

    setChecking(true);
    setError('');

    try {
      const valid = await isPassword(password);
      if (valid) {
        onConfirm();
      } else {
        setError("that doesn't match · please try again");
        setPassword('');
        inputRef.current?.focus();
      }
    } catch {
      setError("zafu couldn't check that just now · please try again");
    } finally {
      setChecking(false);
    }
  }, [password, isPassword, onConfirm]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  if (!open) {
    return null;
  }

  // A radix layer, portaled, at z-[70]: the auth gate is by definition the
  // topmost surface. Rendered inline it was trapped below body-portaled
  // overlays (e.g. the ironwood migrate takeover at z-60). A plain portal was
  // not enough either: opened from inside a radix sheet (a shared wallet's
  // "propose and seal"), the sheet keeps pointer events and focus to itself,
  // so the password box could be neither tapped nor typed into. As a radix
  // layer of its own it sits on top of any open sheet; Esc cancels.
  return (
    <Dialog open onOpenChange={o => !o && onCancel()}>
      <DialogPortal>
        <DialogOverlay className='z-[70] bg-black/60' />
        <DialogLayer
          aria-describedby={undefined}
          onOpenAutoFocus={e => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className='fixed inset-0 z-[70] flex items-center justify-center focus:outline-none'
        >
          <div className='mx-4 w-full max-w-sm border border-border-soft bg-canvas p-5 shadow-xl'>
            <div className='mb-4 flex items-center gap-2'>
              <span className='i-ph-lock h-4 w-4 text-zigner-gold' />
              <DialogTitle className='text-lg font-normal leading-normal tracking-normal'>
                confirm this transaction
              </DialogTitle>
            </div>
            <p className='mb-3 text-xs text-fg-muted'>your password, to sign it.</p>

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
                className='w-full border border-border-soft bg-input px-3 py-2.5 pr-10 text-sm text-fg placeholder:text-fg-muted focus:border-zigner-gold focus:outline-none disabled:opacity-50'
              />
              <button
                type='button'
                onClick={() => setReveal(prev => !prev)}
                className='absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg-high'
              >
                {reveal ? (
                  <span className='i-ph-eye h-3.5 w-3.5' />
                ) : (
                  <span className='i-ph-eye-slash h-3.5 w-3.5' />
                )}
              </button>
            </div>

            {error && <p className='mb-3 text-xs text-red-400'>{error}</p>}

            <div className='flex gap-2'>
              <button
                onClick={onCancel}
                disabled={checking}
                className='flex-1 border border-border-soft px-4 py-3 text-sm text-fg-muted transition-colors hover:bg-elev-1 disabled:opacity-50'
              >
                not now
              </button>
              <button
                onClick={() => void handleSubmit()}
                disabled={checking || !password.trim()}
                className='flex-1 bg-zigner-gold px-4 py-3 text-sm text-zigner-gold-foreground transition-colors hover:bg-primary/90 disabled:opacity-50'
              >
                {checking ? 'checking' : 'sign'}
              </button>
            </div>
          </div>
        </DialogLayer>
      </DialogPortal>
    </Dialog>
  );
};
