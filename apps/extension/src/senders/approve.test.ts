import { describe, it, expect, vi, beforeEach } from 'vitest';
import { alreadyApprovedSender, approveSender } from './approve';
import { AppParameters } from '@penumbra-zone/protobuf/penumbra/core/app/v1/app_pb';

const DEVNET = 'penumbra-testnet-brinance-1';
import { OriginRecord, UserChoice } from '@repo/storage-chrome/records';
import { PopupType } from '../message/popup';
import { localExtStorage } from '@repo/storage-chrome/local';

const mockPopup = vi.hoisted(() => vi.fn());
vi.mock('../popup', () => ({
  popup: mockPopup,
}));

const mockTab = {
  favIconUrl: 'mock://doesntmatter.example.com/mock.ico',
  title: 'Mock Tab Title',
} as chrome.tabs.Tab;

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;

describe('origin approvals', () => {
  beforeEach(() => {
    localMock.clear();
    vi.clearAllMocks();
  });

  describe('approveSender', () => {
    it('prompts and stores choice for a new origin', async () => {
      const messageSender = { origin: 'mock://unknown.example.com', tab: mockTab };

      const newOriginRecord: OriginRecord = {
        choice: UserChoice.Approved,
        date: 123,
        origin: 'mock://unknown.example.com',
      };

      mockPopup.mockResolvedValue(newOriginRecord);

      const choice = await approveSender(messageSender);
      expect(choice).toBe(UserChoice.Approved);
    });

    it('returns stored choice', async () => {
      await localExtStorage.set('knownSites', [
        { origin: 'mock://ignored.example.com', choice: UserChoice.Ignored, date: 123 },
      ]);
      const messageSender = { origin: 'mock://ignored.example.com', tab: mockTab };

      const choice = await approveSender(messageSender);
      expect(choice).toBe(UserChoice.Ignored);
    });

    it('returns denied choice if the popup is closed without a choice', async () => {
      await localExtStorage.set('knownSites', []);
      const messageSender = { origin: 'mock://unknown.example.com', tab: mockTab };
      mockPopup.mockResolvedValue(undefined);

      const choice = await approveSender(messageSender);
      expect(choice).toBe(UserChoice.Denied);
    });

    it('returns denied choice if the popup is denied', async () => {
      await localExtStorage.set('knownSites', []);
      const messageSender = { origin: 'mock://unknown.example.com', tab: mockTab };
      mockPopup.mockResolvedValue({
        choice: UserChoice.Denied,
        date: 123,
        origin: 'mock://unknown.example.com',
      } satisfies OriginRecord);

      const choice = await approveSender(messageSender);
      expect(choice).toBe(UserChoice.Denied);
    });

    it('can update a choice from denied to approved', async () => {
      await localExtStorage.set('knownSites', [
        { origin: 'mock://upsertable.example.com', choice: UserChoice.Denied, date: 123 },
      ]);
      const messageSender = { origin: 'mock://upsertable.example.com', tab: mockTab };

      const newOriginRecord = {
        choice: UserChoice.Approved,
        date: 123,
        origin: 'mock://upsertable.example.com',
      } satisfies OriginRecord;

      mockPopup.mockResolvedValue(newOriginRecord);

      const choice = await approveSender(messageSender);
      expect(choice).toBe(UserChoice.Approved);
    });

    it('calls popup with the correct parameters', async () => {
      await localExtStorage.set('knownSites', []);
      const messageSender = { origin: 'mock://popuptest.example.com', tab: mockTab };
      mockPopup.mockResolvedValue({
        choice: UserChoice.Approved,
        date: 123,
        origin: 'mock://popuptest.example.com',
      } satisfies OriginRecord);

      await approveSender(messageSender);

      expect(mockPopup).toHaveBeenCalledWith(PopupType.OriginApproval, {
        origin: 'mock://popuptest.example.com',
        favIconUrl: mockTab.favIconUrl,
        title: mockTab.title,
        lastRequest: undefined,
        chain: { network: 'penumbra', chainId: 'penumbra-1' },
      });
    });

    it('persists known sites when a new site is added', async () => {
      const existingOriginRecord = {
        choice: UserChoice.Approved,
        date: 456,
        origin: 'mock://known.example.com',
      } satisfies OriginRecord;
      await localExtStorage.set('knownSites', [existingOriginRecord]);

      const messageSender = { origin: 'mock://unknown.example.com', tab: mockTab };
      const newOriginRecord = {
        choice: UserChoice.Approved,
        date: 123,
        origin: 'mock://unknown.example.com',
      } satisfies OriginRecord;
      mockPopup.mockResolvedValue(newOriginRecord);

      await approveSender(messageSender);

      // after upsert, storage contains OriginPermissions shapes
      const stored = await localExtStorage.get('knownSites');
      expect(stored).toHaveLength(2);
    });

    it('a site approved on the testnet is asked again on mainnet, shown the chain', async () => {
      const origin = 'mock://demo.example.com';
      await localExtStorage.set('enabledNetworks', ['penumbra', 'penumbra-testnet']);
      await localExtStorage.set(
        'penumbraTestnetParams',
        new AppParameters({ chainId: DEVNET }).toJsonString(),
      );
      mockPopup.mockResolvedValue({ choice: UserChoice.Approved, date: 1, origin });
      await approveSender({ origin, tab: mockTab });
      expect(mockPopup).toHaveBeenLastCalledWith(
        PopupType.OriginApproval,
        expect.objectContaining({ chain: { network: 'penumbra-testnet', chainId: DEVNET } }),
      );
      expect(await alreadyApprovedSender({ origin } as never)).toBe(true);

      await localExtStorage.set('enabledNetworks', ['penumbra']);
      expect(await alreadyApprovedSender({ origin } as never)).toBe(false);
      mockPopup.mockClear();
      await approveSender({ origin, tab: mockTab });
      expect(mockPopup).toHaveBeenCalledWith(
        PopupType.OriginApproval,
        expect.objectContaining({ chain: { network: 'penumbra', chainId: 'penumbra-1' } }),
      );
    });

    it('a testnet no node has named yet approves no one', async () => {
      const origin = 'mock://early.example.com';
      await localExtStorage.set('enabledNetworks', ['penumbra', 'penumbra-testnet']);
      mockPopup.mockResolvedValue({ choice: UserChoice.Approved, date: 1, origin });
      expect(await approveSender({ origin, tab: mockTab })).toBe(UserChoice.Denied);
      expect(mockPopup).toHaveBeenCalledWith(
        PopupType.OriginApproval,
        expect.objectContaining({ chain: { network: 'penumbra-testnet', chainId: undefined } }),
      );
      expect(await alreadyApprovedSender({ origin } as never)).toBe(false);
    });
  });
});
