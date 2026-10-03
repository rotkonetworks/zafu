import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePopupNav } from '../../../utils/navigate';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { getCosmosChain, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { useStore } from '../../../state';
import { selectEnabledNetworks, type NetworkType } from '../../../state/keyring';
import { useDisableNetwork, useEnableNetwork } from '../../../hooks/enable-network';
import { usePenumbraTotalIn } from '../../../hooks/penumbra-total-in';
import { getRegistryEndpoints } from '../../../config/penumbra-endpoints';
import { getSubnetworks } from '../../../config/networks';
import { probeAllPenumbra } from '../../../state/keyring/penumbra-endpoint-latency';
import { hostOf } from '../../../net/destination';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { NodeSheet } from './node-sheet';
import { TintedRow } from './tinted-row';
import { KeplrCompatToggle } from './keplr-compat-toggle';
import { useExplain } from './settings-explain';
import { RpcPoolSheet } from './transparent-chain-endpoints';

// the bundled registry, resolved once per realm: no remote fetch, and a stable identity
const PRESETS = getRegistryEndpoints();
/** a penumbra ibc chain: a network zafu can turn on, with a cosmos chain config */
type Chain = Extract<CosmosChainId, NetworkType>;
const CHAINS = getSubnetworks('penumbra');

const speedTest = async () => {
  const results = await probeAllPenumbra(PRESETS);
  return new Map(PRESETS.map((p, i) => [p.url, results[i]?.ok ? results[i].latencyMs : null]));
};

const chainName = (id: Chain) => getCosmosChain(id).name.toLowerCase();

type Open = 'node' | 'ibc' | Chain | null;

const openFrom = (params: URLSearchParams): Open => {
  const chain = params.get('chain');
  return chain && CHAINS.includes(chain) ? chain : params.get('sheet') === 'node' ? 'node' : null;
};

/** one ibc chain: on or off, and the nodes it reads from */
const ChainSheet = ({ id, onClose }: { id: Chain; onClose: () => void }) => {
  const on = useStore(s => selectEnabledNetworks(s).includes(id));
  const disable = useDisableNetwork();
  const enable = useEnableNetwork();
  const gone = getCosmosChain(id).deprecation;
  const { explainProps, sheet } = useExplain();
  return (
    <RpcPoolSheet chainId={id} open onOpenChange={o => !o && onClose()}>
      {gone && <StatusSlot tone='warn'>please move funds out by {gone.moveOutBy}</StatusSlot>}
      <RowGroup className='shrink-0'>
        <Row
          type='toggle'
          label={`use ${chainName(id)}`}
          checked={on}
          onChange={v => void (v ? enable(id) : disable(id))}
          {...explainProps('network.ibcChainToggle')}
        />
      </RowGroup>
      {sheet}
    </RpcPoolSheet>
  );
};

/** penumbra network screen (SetPenumbraNet.dc.html): node, ibc chains, turn off */
export const SettingsPenumbraNetwork = () => {
  const [params] = useSearchParams();
  const [open, setOpen] = useState<Open>(() => openFrom(params));
  const enabled = useStore(selectEnabledNetworks);
  const endpoint = useStore(s => s.networks.networks.penumbra.endpoint) ?? '';
  const setEndpoint = useStore(s => s.networks.setNetworkEndpoint);
  const disable = useDisableNetwork();
  const navigate = usePopupNav();
  const { totalIn, setTotalIn } = usePenumbraTotalIn();
  const keepSyncing = useStore(s => s.privacy.settings.keepPenumbraSyncing);
  const setSetting = useStore(s => s.privacy.setSetting);
  const { explainProps, sheet: explainSheet } = useExplain();

  const chainsOn = CHAINS.filter(c => enabled.includes(c));
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
            {...explainProps('network.penumbraNode')}
          />
          <Row
            type='value'
            label='ibc chains'
            value={
              chainsOn.length === 0
                ? 'off'
                : chainsOn.length > 2
                  ? `${chainsOn.length} on`
                  : `${chainsOn.map(chainName).join(', ')} on`
            }
            onPress={() => setOpen('ibc')}
            {...explainProps('network.ibcChains')}
          />
          <Row
            type='value'
            label='total in'
            value={totalIn}
            onPress={() => void setTotalIn(totalIn === 'usd' ? 'um' : 'usd')}
            {...explainProps('network.totalIn')}
          />
          <Row
            type='toggle'
            label='keep syncing when closed'
            checked={keepSyncing}
            onChange={v => void setSetting('keepPenumbraSyncing', v)}
            {...explainProps('network.keepSyncingClosed')}
          />
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
        onExplain={explainProps('network.ownNode').onExplain}
      />

      <Sheet open={open === 'ibc'} onOpenChange={sheet('ibc')} title='ibc chains'>
        <RowGroup>
          {CHAINS.map(c => (
            <Row
              key={c}
              type='value'
              label={chainName(c)}
              value={enabled.includes(c) ? 'on' : 'off'}
              onPress={() => setOpen(c)}
              {...explainProps('network.ibcChainToggle')}
            />
          ))}
        </RowGroup>
        <RowGroup>
          <KeplrCompatToggle {...explainProps('devices.actAsKeplr')} />
        </RowGroup>
      </Sheet>

      {open && CHAINS.includes(open) && <ChainSheet id={open} onClose={() => setOpen('ibc')} />}
      {explainSheet}
    </SettingsScreen>
  );
};
