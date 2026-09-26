/**
 * Which cosmos chains Penumbra can reach over IBC right now, and over which
 * channel pair - asked of the Penumbra node itself.
 *
 * Why not the registries: the Penumbra asset registry and cosmos/chain-registry
 * both still list channels whose Penumbra-side light client has EXPIRED
 * (cosmoshub channel-0, osmosis channel-4, celestia channel-3, axelar
 * channel-7). A channel stays OPEN after its client expires, so the channel
 * state alone says nothing; packets over it can't be relayed and funds sit in
 * escrow. The node's client status is the ground truth.
 *
 * Three queries, all against the user's own Penumbra endpoint (no new party
 * learns anything): Channels, then per transfer channel ChannelClientState
 * (which chain it points at) and ClientStatus (Active or not).
 *
 * Only the Penumbra-side client is checked. Shield-in (funds leaving the cosmos
 * chain) also needs that chain's client of penumbra-1 to be Active; that is
 * not checked here.
 */

import { createClient, type Transport } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { IbcChannelService, IbcClientService } from '@penumbra-zone/protobuf';
import { State } from '@penumbra-zone/protobuf/ibc/core/channel/v1/channel_pb';
import { ClientState as TendermintClientState } from '@penumbra-zone/protobuf/ibc/lightclients/tendermint/v1/tendermint_pb';

/** one Penumbra transfer channel and where it goes */
export interface PenumbraRoute {
  /** counterparty chain id, e.g. 'cosmoshub-4' */
  chainId: string;
  /** channel on Penumbra (penumbra -> chain), e.g. 'channel-22' */
  penumbraSourceChannel: string;
  /** channel on the counterparty (chain -> penumbra), e.g. 'channel-1934' */
  penumbraChannel: string;
  /** the Penumbra-side light client is Active */
  active: boolean;
}

const channelNumber = (id: string): number => Number(id.replace(/^channel-/, ''));

/** ask the Penumbra node for every transfer channel, its chain and client status */
export async function discoverPenumbraRoutes(
  grpcEndpoint: string,
  transport: Transport = createGrpcWebTransport({ baseUrl: grpcEndpoint }),
): Promise<PenumbraRoute[]> {
  const channels = createClient(IbcChannelService, transport);
  const clients = createClient(IbcClientService, transport);

  const { channels: all } = await channels.channels({});
  const open = all.filter(c => c.portId === 'transfer' && c.state === State.OPEN);

  const routes = await Promise.all(
    open.map(async (c): Promise<PenumbraRoute | undefined> => {
      const { identifiedClientState } = await channels.channelClientState({
        portId: 'transfer',
        channelId: c.channelId,
      });
      const any = identifiedClientState?.clientState;
      if (!identifiedClientState || !any) {
        return undefined;
      }
      const tm = new TendermintClientState();
      // a non-tendermint client can't be a cosmos chain we route to
      if (!any.unpackTo(tm) || !tm.chainId) {
        return undefined;
      }
      const { status } = await clients.clientStatus({ clientId: identifiedClientState.clientId });
      return {
        chainId: tm.chainId,
        penumbraSourceChannel: c.channelId,
        penumbraChannel: c.counterparty?.channelId ?? '',
        active: status === 'Active',
      };
    }),
  );
  return routes.filter((r): r is PenumbraRoute => !!r && !!r.penumbraChannel);
}

/**
 * The route to use for a chain, or undefined when there is none.
 *
 * Several Active channels can lead to one chain (osmosis has 19 and 20). Pick
 * the pinned one when it is Active, else the lowest-numbered Active one - the
 * denom a token gets on Penumbra embeds the channel, so this rule has to agree
 * with what the Penumbra asset registry labels. A pinned channel whose client
 * is not Active is never returned: that is exactly the stale-pin case.
 */
export function selectPenumbraRoute(
  routes: PenumbraRoute[],
  chainId: string,
  pinnedSourceChannel?: string,
): PenumbraRoute | undefined {
  const live = routes.filter(r => r.chainId === chainId && r.active);
  const pinned = live.find(r => r.penumbraSourceChannel === pinnedSourceChannel);
  if (pinned) {
    return pinned;
  }
  return live.sort(
    (a, b) => channelNumber(a.penumbraSourceChannel) - channelNumber(b.penumbraSourceChannel),
  )[0];
}
