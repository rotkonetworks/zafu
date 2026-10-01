import { ChainRegistryClient } from '@penumbrafi/registry';
import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { localExtStorage } from '@repo/storage-chrome/local';
import { AppService, SctService } from '@penumbra-zone/protobuf';
import { fetchBlockHeightWithFallback } from '../../../hooks/latest-block-height';
import { SEED_PHRASE_ORIGIN } from './password/types';
import { DEFAULT_FRONTEND, DEFAULT_TRANSPORT_OPTS } from './constants';

export const setOnboardingValuesInStorage = async (seedPhraseOrigin: SEED_PHRASE_ORIGIN) => {
  await localExtStorage.set('frontendUrl', DEFAULT_FRONTEND);

  if (seedPhraseOrigin === SEED_PHRASE_ORIGIN.IMPORTED) {
    // Importing means the user typed the phrase from an existing backup -
    // they demonstrably possess it. Suppress the home backup nudge.
    await localExtStorage.set('seedPhraseBackedUp', true);
  }

  // Everything below talks to Penumbra and its registry: only for a wallet
  // that chose Penumbra. A Zcash-only onboarding contacts nothing else.
  if (!(await localExtStorage.get('enabledNetworks'))?.includes('penumbra')) {
    return;
  }
  const chainRegistryClient = new ChainRegistryClient();
  const { rpcs } = await chainRegistryClient.remote.globals();

  // Queries for block height regardless of 'SEED_PHRASE_ORIGIN' as a means of testing endpoint for liveness.
  const { blockHeight, rpc } = await fetchBlockHeightWithFallback(rpcs.map(r => r.url));

  // Persist the RPC to LS storage.
  await localExtStorage.set('grpcEndpoint', rpc);

  if (seedPhraseOrigin === SEED_PHRASE_ORIGIN.NEWLY_GENERATED) {
    // Penumbra's birthday for a fresh wallet, unless something set it already.
    const existingCreationHeight = await localExtStorage.get('walletCreationBlockHeight');
    if (!existingCreationHeight) {
      await localExtStorage.set('walletCreationBlockHeight', blockHeight);

      try {
        const compactFrontier = await createClient(
          SctService,
          createGrpcWebTransport({ baseUrl: rpc }),
        ).sctFrontier({ withProof: false }, DEFAULT_TRANSPORT_OPTS);
        await localExtStorage.set('compactFrontierBlockHeight', Number(compactFrontier.height));
      } catch (error) {
        await localExtStorage.set('compactFrontierBlockHeight', blockHeight);
      }
    }
  }

  try {
    // Fetch registry and persist the numeraires to LS storage.
    const { appParameters } = await createClient(
      AppService,
      createGrpcWebTransport({ baseUrl: rpc }),
    ).appParameters({}, DEFAULT_TRANSPORT_OPTS);
    if (!appParameters?.chainId) {
      throw new Error('No chain id');
    }

    const { numeraires } = await chainRegistryClient.remote.get(appParameters.chainId);
    if (!numeraires.length) {
      throw new Error('Empty numeraires list from registry');
    }

    await localExtStorage.set(
      'numeraires',
      numeraires.map(n => n.toJsonString()),
    );
  } catch {
    console.warn('Failed to fetch or store numeraires; continuing onboarding anyway.');
  }
};
