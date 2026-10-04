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
 * The answers only ever DISABLE a pair the registry pins (see
 * pinnedRouteStatus); they never pick one.
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

/** a channel pair as the registry pins it */
export interface PinnedPair {
  penumbraSourceChannel: string;
  penumbraChannel: string;
}

/**
 * Whether the registry's pinned channel pair for a chain can carry funds right
 * now: 'active' when discovery reports that exact pair with an Active client,
 * 'inactive' otherwise.
 *
 * Discovery can only take a pair away, never offer one. Its answers carry no
 * proofs, and the chain id it reports is whatever the client's creator wrote:
 * opening an IBC client and channel on Penumbra is permissionless, so anyone
 * can open a channel to a chain of their own that calls itself `injective-1`.
 * Taking "the lowest Active channel that claims the chain" (as this once did,
 * whenever the pin was not Active) would send a shield-in or a withdraw to
 * whoever opened that channel, and a node the user picked could hand back
 * any pair it liked. So the pair always comes from the bundled or signed
 * registry, the reported chain id is not read at all, and both ends of the
 * pair must match: a node that reports the pinned Penumbra channel with
 * another counterparty is answered with 'inactive' too.
 */
export function pinnedRouteStatus(
  routes: readonly PenumbraRoute[],
  pin: PinnedPair,
): 'active' | 'inactive' {
  const live = routes.some(
    r =>
      r.active &&
      r.penumbraSourceChannel === pin.penumbraSourceChannel &&
      r.penumbraChannel === pin.penumbraChannel,
  );
  return live ? 'active' : 'inactive';
}
