import { useEffect, useState } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { ToggleSwitch } from '../../../components/toggle-switch';

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
    <div className='flex items-start justify-between gap-3 rounded-lg border border-border-soft bg-elev-1 p-3'>
      <div className='flex flex-col gap-1'>
        <span className='text-sm text-fg-high'>act as keplr</span>
        <span className='text-xs text-fg-muted'>
          {enabled
            ? 'cosmos dapps see zafu as keplr — applies on next page load'
            : 'off — a real keplr extension is left untouched'}
        </span>
      </div>
      <ToggleSwitch checked={enabled} onChange={toggle} />
    </div>
  );
}
