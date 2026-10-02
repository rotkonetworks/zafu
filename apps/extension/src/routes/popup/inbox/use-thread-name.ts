import { useStore } from '../../../state';
import { useZcashMeDirectoryLookup } from '../../../services/zcashme/config';
import { zcashMeLabel } from '../../../services/zcashme/label';
import { shortAddress } from './threads';

/** the name a thread goes by: your contact, then a zcash.me name, then the short address */
export const useThreadName = (address: string | undefined): string => {
  const contactName = useStore(s =>
    address ? s.contacts.findByAddress(address)?.contact.name : undefined,
  );
  const directory = useZcashMeDirectoryLookup();
  return (
    contactName || zcashMeLabel(directory(address)) || (address ? shortAddress(address) : 'someone')
  );
};
