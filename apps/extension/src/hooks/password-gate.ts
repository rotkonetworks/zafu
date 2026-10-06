/**
 * password gate hook - prompts for password before transactions
 *
 * usage:
 *   const { requestAuth, PasswordModal } = usePasswordGate();
 *   // in submit handler:
 *   const ok = await requestAuth();
 *   if (!ok) return;
 *   // proceed with transaction
 */

import { useState, useCallback, useRef, createElement } from 'react';
import { PasswordGateModal } from '../shared/components/password-gate';
import { useStore } from '../state';
import { selectEffectiveKeyInfo } from '../state/keyring';
import { CAPS, walletKind } from '../signing/wallet-kind';

interface GateCallbacks {
  resolve: (authorized: boolean) => void;
}

export const usePasswordGate = () => {
  const [open, setOpen] = useState(false);
  const callbacksRef = useRef<GateCallbacks | null>(null);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);

  // a password unlocks what zafu holds (a phrase, a multisig share). a device
  // signs on its own: its review and qr are the confirmation, so there is
  // nothing to ask here
  const deviceRef = useRef(false);
  deviceRef.current = !!selectedKeyInfo && !CAPS[walletKind(selectedKeyInfo)].unlockToSign;

  const requestAuth = useCallback((): Promise<boolean> => {
    if (deviceRef.current) {
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
