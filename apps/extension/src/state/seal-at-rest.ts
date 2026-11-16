import { sealNetEgressLog } from '../net/ledger';
import { sealZcashMeApiKey } from '../services/zcashme/api-key';
import { readTxNotes } from './personal-data';
import { sealSentRecords } from './sent-seal';

/**
 * What an older version, a restore or a locked moment left plain, sealed once
 * the wallet is open. Runs on every unlock; each step does nothing when there
 * is nothing to seal, and nothing while locked.
 */
export const sealAtRest = async (): Promise<void> => {
  await Promise.allSettled([
    // a plain map is sealed on its first read
    readTxNotes(),
    sealZcashMeApiKey(),
    sealNetEgressLog(),
    sealSentRecords(),
    // the retired conversation labels: written plain, never read back
    chrome.storage.local.remove('inboxLabels'),
  ]);
};
