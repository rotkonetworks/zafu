import { useEffect, useState } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { Row } from '@repo/ui/components/ui/row';

/**
 * A wallet slot zafu takes on pages only when asked: "act as keplr"
 * (window.keplr) and "act as window.ethereum". Off leaves the slot to a real
 * wallet. Plaintext local storage, since the content script reads it without
 * a session key; it applies on the next page load.
 */
export function CompatToggle({
  storageKey,
  label,
  off,
  onExplain,
}: {
  storageKey: 'keplrCompat' | 'evmWindowEthereum';
  label: string;
  /** what off means, in a few words */
  off: string;
  onExplain?: (label: string) => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    void localExtStorage.get(storageKey).then(v => setEnabled(v === true));
  }, [storageKey]);

  if (enabled === null) {
    return null;
  }

  return (
    <Row
      type='toggle'
      label={label}
      description={enabled ? 'applies on the next page load' : `off - ${off}`}
      checked={enabled}
      onChange={v => {
        setEnabled(v);
        void localExtStorage.set(storageKey, v);
      }}
      onExplain={onExplain}
    />
  );
}
