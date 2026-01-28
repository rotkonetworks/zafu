import { DutchAuctionDescription } from '@penumbra-zone/protobuf/penumbra/core/component/auction/v1/auction_pb';
import { getAssetId } from '@penumbra-zone/getters/metadata';
import { IndexedDbInterface } from '@rotko/penumbra-types/indexed-db';
import { getAuctionId, getAuctionNftMetadata } from '@rotko/penumbra-wasm/auction';

export const processActionDutchAuctionSchedule = async (
  description: DutchAuctionDescription,
  indexedDb: IndexedDbInterface,
) => {
  const auctionId = getAuctionId(description);

  // Always a sequence number of 0 when starting a Dutch auction
  const seqNum = 0n;

  const metadata = getAuctionNftMetadata(auctionId, seqNum);

  await Promise.all([
    indexedDb.saveAssetsMetadata({ ...metadata, penumbraAssetId: getAssetId(metadata) }),
    indexedDb.upsertAuction(auctionId, {
      auction: description,
      seqNum,
    }),
  ]);
};
