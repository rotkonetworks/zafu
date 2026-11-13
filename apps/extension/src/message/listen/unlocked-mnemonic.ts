/**
 * The selected wallet's mnemonic, unlocking zafu first when its session has
 * lapsed: the unlock screen opens (side panel or a login window) and this waits,
 * as signing and connect requests already do. Null when there is no wallet or the
 * user closes the unlock without unlocking - the caller answers `locked` then,
 * rather than failing inside the keyring with "keyring locked".
 */
export const unlockedMnemonic = async (): Promise<string | null> => {
  try {
    const { throwIfNeedsLogin } = await import('../../needs-login');
    await throwIfNeedsLogin();
  } catch {
    return null;
  }
  const { useStore } = await import('../../state');
  const keyInfo = useStore.getState().keyRing.selectedKeyInfo;
  if (!keyInfo) {
    return null;
  }
  try {
    return await useStore.getState().keyRing.getMnemonic(keyInfo.id);
  } catch {
    return null;
  }
};
