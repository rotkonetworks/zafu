import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '.';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

/**
 * The lifecycle of an outgoing record, and specifically what a wallet is
 * allowed to claim about a send whose outcome it did not observe.
 */
describe('messages — outgoing send lifecycle', () => {
  let useStore: TestStore;
  const messages = () => useStore.getState().messages;

  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });

  const startSend = async () =>
    messages().addOutgoingPending({
      network: 'zcash',
      recipientAddress: 'u1recipient',
      content: 'hello',
      amount: '0.01',
      asset: 'ZEC',
    });

  test('a send in flight is submitting, with a temp id', async () => {
    const { tempTxId } = await startSend();
    expect(tempTxId.startsWith('temp:')).toBe(true);
    expect(messages().messages[0]!.status).toBe('submitting');
  });

  test('losing sight of a send reports unknown, not failure', async () => {
    const { tempTxId } = await startSend();
    await messages().markOutgoingInterrupted(tempTxId, 'popup closed');
    const m = messages().messages[0]!;
    // 'failed' would assert the payment did not happen. The worker may well
    // have broadcast it; we simply stopped watching.
    expect(m.status).toBe('interrupted');
    expect(m.status).not.toBe('failed');
    expect(m.failureReason).toBe('popup closed');
  });

  test('an interrupted record still reconciles with the real txid', async () => {
    const { tempTxId } = await startSend();
    await messages().markOutgoingInterrupted(tempTxId, 'popup closed');

    // the flow survived after all (side panel / tab): it learns the txid
    await messages().promoteOutgoing(tempTxId, 'abc123');
    let m = messages().messages[0]!;
    expect(m.txId).toBe('abc123');
    expect(m.status).toBe('broadcasting');
    expect(m.failureReason).toBeUndefined();

    await messages().markOutgoingBroadcast('abc123');
    expect(messages().messages[0]!.status).toBe('pending');

    // block scan confirms it — dedup on (txId, direction) promotes in place
    await messages().addMessage({
      network: 'zcash',
      recipientAddress: '',
      content: 'hello',
      txId: 'abc123',
      blockHeight: 3_000_000,
      timestamp: Date.now(),
      direction: 'sent',
      read: true,
    });
    m = messages().messages[0]!;
    expect(messages().messages).toHaveLength(1);
    expect(m.status).toBe('confirmed');
    expect(m.blockHeight).toBe(3_000_000);
  });

  test('interrupted does not overwrite an outcome the wallet actually observed', async () => {
    const { tempTxId } = await startSend();
    await messages().promoteOutgoing(tempTxId, 'abc123');
    await messages().markOutgoingBroadcast('abc123');

    await messages().markOutgoingInterrupted('abc123', 'popup closed');
    // it reached the mempool; "unknown" would be a downgrade of real knowledge
    expect(messages().messages[0]!.status).toBe('pending');

    await messages().markOutgoingFailed('abc123', 'expired');
    await messages().markOutgoingInterrupted('abc123', 'popup closed');
    expect(messages().messages[0]!.status).toBe('failed');
  });

  test('a genuine build error is still reported as a failure', async () => {
    const { tempTxId } = await startSend();
    await messages().markOutgoingFailed(tempTxId, 'insufficient funds');
    expect(messages().messages[0]!.status).toBe('failed');
    expect(messages().messages[0]!.failureReason).toBe('insufficient funds');
  });
});
