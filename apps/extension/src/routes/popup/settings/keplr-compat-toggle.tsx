import { useEffect, useState } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { Row, RowGroup } from '@repo/ui/components/ui/row';

/**
 * "Act as Keplr" toggle. Lives under the Penumbra network section because
 * it only affects Cosmos-family dapps talking to `window.keplr`. Off keeps
 * a real Keplr extension untouched; on makes Zafu shadow the Keplr provider
 * so IBC-adjacent dapps that only know Keplr can talk to Zafu.
 *
 * Storage lives in plaintext local storage (`keplrCompat`) because the
 * content script needs to read it without a session key.
 */
export function KeplrCompatToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    void localExtStorage.get('keplrCompat').then(v => setEnabled(v === true));
  }, []);

  const toggle = (v: boolean): void => {
    setEnabled(v);
    void localExtStorage.set('keplrCompat', v);
  };

  if (enabled === null) {
    return null;
  }

  return (
    <RowGroup>
      <Row
        type='toggle'
        label='act as keplr'
        description={
          enabled
            ? 'cosmos dapps see zafu as keplr — applies on next page load'
            : 'off — a real keplr extension is left untouched'
        }
        checked={enabled}
        onChange={toggle}
      />
    </RowGroup>
  );
}
