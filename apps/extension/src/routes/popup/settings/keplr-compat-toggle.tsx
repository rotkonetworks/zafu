import { useEffect, useState } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { Row } from '@repo/ui/components/ui/row';

/**
 * "act as keplr": on, zafu answers cosmos dapps that only know `window.keplr`;
 * off leaves a real keplr extension untouched. Plaintext local storage, since
 * the content script reads it without a session key.
 */
export function KeplrCompatToggle({ onExplain }: { onExplain?: () => void } = {}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    void localExtStorage.get('keplrCompat').then(v => setEnabled(v === true));
  }, []);

  if (enabled === null) {
    return null;
  }

  return (
    <Row
      type='toggle'
      label='act as keplr'
      description={
        enabled ? 'applies on the next page load' : 'off - a real keplr extension is left untouched'
      }
      checked={enabled}
      onChange={v => {
        setEnabled(v);
        void localExtStorage.set('keplrCompat', v);
      }}
      onExplain={onExplain}
    />
  );
}
