import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePopupNav } from '../../../utils/navigate';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { useStore } from '../../../state';
import { useDisableNetwork } from '../../../hooks/enable-network';
import { usePenumbraTotalIn } from '../../../hooks/penumbra-total-in';
import { getRegistryEndpoints } from '../../../config/penumbra-endpoints';
import { probeAllPenumbra } from '../../../state/keyring/penumbra-endpoint-latency';
import { hostOf } from '../../../net/destination';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { NodeSheet } from './node-sheet';
import { TintedRow } from './tinted-row';
import { KeplrCompatToggle } from './keplr-compat-toggle';

// the bundled registry, resolved once per realm: no remote fetch, and a stable identity
const PRESETS = getRegistryEndpoints();
const speedTest = async () => {
  const results = await probeAllPenumbra(PRESETS);
  return new Map(PRESETS.map((p, i) => [p.url, results[i]?.ok ? results[i].latencyMs : null]));
};

type Open = 'node' | null;

/** penumbra network screen (SetPenumbraNet.dc.html): node, total in, turn off */
export const SettingsPenumbraNetwork = () => {
  const [params] = useSearchParams();
  const [open, setOpen] = useState<Open>(() => (params.get('sheet') === 'node' ? 'node' : null));
  const endpoint = useStore(s => s.networks.networks.penumbra.endpoint) ?? '';
  const setEndpoint = useStore(s => s.networks.setNetworkEndpoint);
  const disable = useDisableNetwork();
  const navigate = usePopupNav();
  const { totalIn, setTotalIn } = usePenumbraTotalIn();
  const sheet = (o: Open) => (next: boolean) => setOpen(next ? o : null);

  return (
    <SettingsScreen title='penumbra' category='networks' backPath={PopupPath.SETTINGS_NETWORKS}>
      <div className='flex flex-col gap-4'>
        <RowGroup>
          <Row
            type='value'
            label='node'
            value={hostOf(endpoint) ?? 'auto'}
            onPress={() => setOpen('node')}
          />
          <Row
            type='value'
            label='total in'
            value={totalIn}
            onPress={() => void setTotalIn(totalIn === 'usd' ? 'um' : 'usd')}
          />
          <KeplrCompatToggle />
        </RowGroup>
        <RowGroup>
          <TintedRow
            label='turn off penumbra'
            onPress={() =>
              void disable('penumbra').then(() =>
                navigate(PopupPath.SETTINGS_NETWORKS, { replace: true }),
              )
            }
          />
        </RowGroup>
      </div>

      <NodeSheet
        open={open === 'node'}
        onOpenChange={sheet('node')}
        title='penumbra node'
        presets={PRESETS}
        current={endpoint}
        egress='penumbra-servers'
        measure={speedTest}
        onPick={url => setEndpoint('penumbra', url)}
      />
    </SettingsScreen>
  );
};
