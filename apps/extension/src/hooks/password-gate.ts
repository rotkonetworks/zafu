/**
 * password gate hook - prompts for password before transactions
 *
 * usage:
 *   const { requestAuth, PasswordModal } = usePasswordGate();
 *   // in submit handler, naming what the action opens:
 *   const ok = await requestAuth(); // a secret held here: always asks
 *   const ok = await requestAuth('nothing'); // a device signs: no dialog
 */

import { useState, useCallback, useRef, createElement } from 'react';
import { PasswordGateModal } from '../shared/components/password-gate';

/**
 * What an action unseals. 'secret' is anything zafu holds (a phrase, a
 * multisig share, a rune key); 'nothing' is a pure device signature (zigner,
 * keystone, ledger), whose own review and qr or usb are the confirmation.
 * The caller says it, never the selected wallet: unsealing a share while a
 * zigner is selected is still a secret, and forgetting to say asks.
 */
export type Unseals = 'secret' | 'nothing';

interface GateCallbacks {
  resolve: (authorized: boolean) => void;
}

export const usePasswordGate = () => {
  const [open, setOpen] = useState(false);
  const callbacksRef = useRef<GateCallbacks | null>(null);

  const requestAuth = useCallback((unseals: Unseals = 'secret'): Promise<boolean> => {
    if (unseals === 'nothing') {
      return Promise.resolve(true);
    }
    return new Promise<boolean>(resolve => {
      callbacksRef.current = { resolve };
      setOpen(true);
    });
  }, []);

  const handleConfirm = useCallback(() => {
    setOpen(false);
    callbacksRef.current?.resolve(true);
    callbacksRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    setOpen(false);
    callbacksRef.current?.resolve(false);
    callbacksRef.current = null;
  }, []);

  const PasswordModal = createElement(PasswordGateModal, {
    open,
    onConfirm: handleConfirm,
    onCancel: handleCancel,
  });

  return { requestAuth, PasswordModal };
};
