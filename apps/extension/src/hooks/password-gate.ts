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

interface GateCallbacks {
  resolve: (authorized: boolean) => void;
}

export const usePasswordGate = () => {
  const [open, setOpen] = useState(false);
  const callbacksRef = useRef<GateCallbacks | null>(null);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);

  // multisig vaults are AES-encrypted with the user's password, same as
  // mnemonic vaults — only zigner-zafu vaults need the air-gapped QR flow.
  const walletType = selectedKeyInfo?.type === 'zigner-zafu' ? 'zigner' : 'mnemonic';

  const requestAuth = useCallback((): Promise<boolean> => {
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
    walletType,
  });

  return { requestAuth, PasswordModal };
};
