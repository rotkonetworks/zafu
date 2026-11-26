import { getOriginRecord, upsertOriginRecord } from '@repo/storage-chrome/origin';
import { UserChoice } from '@repo/storage-chrome/records';
import { PopupType } from '../message/popup';
import { readPenumbraChain } from '../penumbra/active-chain';
import { popup } from '../popup';
import { PrerenderingExternalSender, ValidExternalSender } from './external';

/**
 * Obtain approval status from storage, as boolean: approved on the penumbra
 * chain in use (a testnet grant does not open mainnet).
 *
 * @param validSender A sender that has already been validated
 * @returns true if an existing record indicates this sender is approved
 */
export const alreadyApprovedSender = async (
  validSender: ValidExternalSender | PrerenderingExternalSender,
): Promise<boolean> =>
  getOriginRecord(validSender.origin, (await readPenumbraChain()).chainId).then(
    r => r?.choice === UserChoice.Approved,
  );

/**
 * Obtain the approval status of an origin, for use by connection request
 * handler. Input origins should already be validated.
 *
 * @param approve A sender that has already been validated
 * @returns The user's choice about the origin, from storage or fresh off the popup
 */
export const approveSender = async (approve: {
  origin: string;
  tab: chrome.tabs.Tab;
}): Promise<UserChoice> => {
  // the chain is read once: the popup shows it, and an approval is bound to it
  const { network, chainId } = await readPenumbraChain();
  const existingRecord = await getOriginRecord(approve.origin, chainId);

  switch (existingRecord?.choice) {
    case UserChoice.Approved:
    case UserChoice.Ignored:
      return existingRecord.choice;

    case UserChoice.Denied:
    case undefined: {
      const popupResponse = await popup(PopupType.OriginApproval, {
        origin: approve.origin,
        favIconUrl: approve.tab.favIconUrl,
        title: approve.tab.title,
        lastRequest: existingRecord?.date,
        chain: { network, chainId },
      });

      // if user interacted with popup, update record
      if (popupResponse) {
        await upsertOriginRecord(popupResponse, chainId);
      }

      // return choice, or default denial; no approval stands without a chain
      return chainId ? (popupResponse?.choice ?? UserChoice.Denied) : UserChoice.Denied;
    }
  }
};
