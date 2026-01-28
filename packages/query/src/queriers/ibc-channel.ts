import { Client } from '@connectrpc/connect';
import { createClient } from './utils';
import { IbcChannelService } from '@penumbra-zone/protobuf';
import {
  QueryChannelRequest,
  QueryChannelResponse,
  QueryChannelClientStateRequest,
  QueryChannelClientStateResponse,
} from '@penumbra-zone/protobuf/ibc/core/channel/v1/query_pb';

export class IbcChannelQuerier {
  private readonly client: Client<typeof IbcChannelService>;

  constructor({ grpcEndpoint }: { grpcEndpoint: string }) {
    this.client = createClient(grpcEndpoint, IbcChannelService);
  }

  async channel(req: QueryChannelRequest): Promise<QueryChannelResponse> {
    return await this.client.channel(req);
  }

  async channelClientState(req: QueryChannelClientStateRequest): Promise<QueryChannelClientStateResponse> {
    return await this.client.channelClientState(req);
  }
}
