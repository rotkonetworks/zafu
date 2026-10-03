import { BlockProcessor } from '@penumbra-zone/query/block-processor';
import { RootQuerier } from '@penumbra-zone/query/root-querier';
import { IndexedDb } from '@penumbra-zone/storage/indexed-db';
import { ViewServer } from '@penumbrafi/wasm/view-server';
import { ServicesInterface, WalletServices } from '@penumbrafi/types/services';
import { FullViewingKey, WalletId } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { AssetId } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { withBundledFallback } from './registry-client';
import { CompactBlock } from '@penumbra-zone/protobuf/penumbra/core/component/compact_block/v1/compact_block_pb';
import { SctFrontierRequest } from '@penumbra-zone/protobuf/penumbra/core/component/sct/v1/sct_pb';

export interface ServicesConfig {
  readonly chainId: string;
  readonly grpcEndpoint: string;
  readonly walletId: WalletId;
  readonly fullViewingKey: FullViewingKey;
  readonly numeraires: AssetId[];
  readonly walletCreationBlockHeight: number | undefined;
  readonly compactFrontierBlockHeight: number | undefined;
  /**
   * Sees the block processor before anything can start it, so a caller can
   * pause or hold it first (every window closed, a chain id still unconfirmed).
   */
  readonly onBlockProcessor?: (blockProcessor: BlockProcessor) => void;
  /** told when each startup phase ends and when it began, for timing a cold start */
  readonly onPhase?: (phase: string, since: number) => void;
}

export class Services implements ServicesInterface {
  private walletServicesPromise: Promise<WalletServices> | undefined;

  constructor(private config: ServicesConfig) {}

  // If getWalletServices() is called multiple times concurrently, they'll all
  // wait for the same promise rather than each starting their own
  // initialization process.
  public async getWalletServices(): Promise<WalletServices> {
    this.walletServicesPromise ??= this.initializeWalletServices().catch((e: unknown) => {
      // If promise rejected, reset promise to `undefined` so next caller can try again.
      this.walletServicesPromise = undefined;
      throw e;
    });

    // Every call here (one per dapp RPC that needs wallet services, not just
    // the first) chains its own .then onto the shared, memoized sync()
    // promise. Uncaught, each one surfaces its own "Uncaught (in promise)"
    // once blockProcessor.stop(reason) aborts it - one per caller that ever
    // asked for services during this processor's life, not just one.
    void this.walletServicesPromise.then(({ blockProcessor }) =>
      blockProcessor
        .sync()
        .catch((e: unknown) => console.error('[penumbra] block processor sync failed:', e)),
    );
    return this.walletServicesPromise;
  }

  // In the current construction, there's isn't an idiomatic way to distinguish between different
  // wallet states (ie. fresh versus existing wallets) past the onboarding phase. The wallet birthday
  // originally served as a proxy for effectuating this distinction, enabling the block processor
  // to skip heavy cryptographic operations like trial decryption and merkle tree operations like
  // poseidon hashing on TCT insertions. Now, the wallet birthday serves a different purpose:
  // identifying fresh wallets and performing a one-time request to retrieve the SCT frontier.
  // This snapshot is injected into into the view server state from which normal
  // block processor syncing can then resume.
  private async initializeWalletServices(): Promise<WalletServices> {
    const {
      chainId,
      grpcEndpoint,
      walletId,
      fullViewingKey,
      numeraires,
      walletCreationBlockHeight,
      compactFrontierBlockHeight,
      onBlockProcessor,
      onPhase,
    } = this.config;
    let t = performance.now();
    const querier = new RootQuerier({ grpcEndpoint });
    // `IndexedDb.initialize` pre-populates asset metadata from the remote
    // registry and logs its own error if that fetch fails; the fallback client
    // resolves offline boots from the bundled copy instead (see registry-client.ts).
    const registryClient = withBundledFallback();
    const indexedDb = await IndexedDb.initialize({
      chainId,
      walletId,
      registryClient,
    });
    onPhase?.('db', t);
    t = performance.now();

    let viewServer: ViewServer | undefined;
    // the block processor seeds a fresh wallet when its stored height is the
    // frontier's, so it must see the height the snapshot actually came from,
    // not the earlier tip the birthday was taken at
    let frontierHeight = compactFrontierBlockHeight;

    // 'fullSyncHeight' will always be undefined after onboarding independent
    // of the wallet type. On subsequent service worker inits, the field will
    // be defined. The additional cost paid here is a single storage access.
    const fullSyncHeight = await indexedDb.getFullSyncHeight();

    // Gate the type of initialization we perform here:
    //
    // * If the wallet is freshly generated, the other storage parameters in
    //   the first conditional will be set. in the case, the wallet saves
    //   the 'fullSyncHeight', pull the state commitment frontier snapshot
    //   from the full node, and instructs the block processor to start syncing
    //   from that snapshot height.
    //
    // * After a normal normal service worker lifecycle termination <> initialization
    //   game, wallet serices will be triggered and the service worker will pull
    //   the latest state commitment tree state from storage to initialize the
    //   view server and resume block processor.
    //
    // * After a cache reset, wallet serices will be triggered and block prcoessing
    //   will initiate genesis sync, taking advantage of the existing "wallet birthday"
    //   acceleration techniques.

    // note: we try-catch the snapshot initialization to fallback to normal initialization
    // if it fails for any reason to not block onboarding completion.
    //
    // Nothing is written until the snapshot is in hand: the frontier and its
    // height are saved together, in one transaction, only once the view server
    // holds that frontier. Writing the height first (as this once did) left a
    // failed init with an EMPTY stored tree at the snapshot height, and the
    // sync then read on from there with every position counted from zero -
    // wrong nullifiers, an anchor no chain ever had. Saving the frontier now,
    // rather than at the first flush, also means a sync paused before its
    // first flush resets to this frontier, never to an empty tree.
    // `=== undefined`, not falsy: a genesis read stores height 0 at its first
    // flush, and a snapshot written over that tree would mix the two
    if (fullSyncHeight === undefined && walletCreationBlockHeight && compactFrontierBlockHeight) {
      try {
        // Request frontier snapshot from full node (~1KB payload) and initialize
        // the view server from that snapshot.
        const compact_frontier = await querier.sct.sctFrontier(
          new SctFrontierRequest({ withProof: false }),
        );

        const snapshot = await ViewServer.initialize_from_snapshot({
          fullViewingKey,
          getStoredTree: () => indexedDb.getStateCommitmentTree(),

          idbConstants: indexedDb.constants(),
          compact_frontier,
        });

        // a snapshot server reports no height of its own (u64::MAX until it
        // scans a block), so the height is the frontier's
        await indexedDb.saveScanResult({
          ...snapshot.flushUpdates(),
          height: compact_frontier.height,
        });
        viewServer = snapshot;
        frontierHeight = Number(compact_frontier.height);
      } catch (e) {
        console.warn('[penumbra] snapshot start failed; reading the chain from genesis:', e);
        // Fall back to normal initialization: nothing was stored, so this is
        // a plain genesis read, and the block processor must not take it for
        // a snapshot wallet
        frontierHeight = undefined;
        viewServer = await ViewServer.initialize({
          fullViewingKey,
          getStoredTree: () => indexedDb.getStateCommitmentTree(),

          idbConstants: indexedDb.constants(),
        });
      }
    } else {
      // Initialize the view server from existing IndexedDB storage.
      viewServer = await ViewServer.initialize({
        fullViewingKey,
        getStoredTree: () => indexedDb.getStateCommitmentTree(),
        idbConstants: indexedDb.constants(),
      });
    }

    onPhase?.('wasm view server (tree load)', t);
    t = performance.now();

    // Dynamically fetch the 'local' genesis file from the exentsion's
    // static assets.
    const response = await fetch('./penumbra-1-genesis.bin');
    const genesisBinaryData = await response.arrayBuffer();

    const blockProcessor = new BlockProcessor({
      genesisBlock:
        chainId === 'penumbra-1'
          ? CompactBlock.fromBinary(new Uint8Array(genesisBinaryData))
          : undefined,
      viewServer,
      querier,
      indexedDb,
      stakingAssetId: registryClient.bundled.globals().stakingAssetId,
      numeraires,
      walletCreationBlockHeight,
      compactFrontierBlockHeight: frontierHeight,
      fullViewingKey,
    });
    onPhase?.('genesis', t);
    onBlockProcessor?.(blockProcessor);

    return { viewServer, blockProcessor, indexedDb, querier };
  }
}
