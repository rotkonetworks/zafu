/**
 * This wallet's remembered addresses on one chain ("yours"), and remembering
 * another. A locked wallet reads as none: nothing here ever writes on a read.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from '../state';
import { selectEffectiveKeyInfo } from '../state/keyring';
import { pocketOwner } from '../state/pockets';
import { readYourAddresses, rememberYourAddress, yoursOn } from '../state/your-addresses';
import type { AddressChain } from '../addresses/kind';

const KEY = ['your-addresses'];

export const useYourAddresses = (chain: AddressChain | undefined) => {
  const owner = useStore(s => {
    const k = selectEffectiveKeyInfo(s);
    return k ? pocketOwner(k) : undefined;
  });
  const client = useQueryClient();
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: () => readYourAddresses().catch(() => []),
    staleTime: Infinity,
  });
  const yours = owner && chain ? yoursOn(data ?? [], owner, chain) : [];
  const remember = async (address: string) => {
    if (owner && chain) {
      await rememberYourAddress({ owner, chain, address });
      await client.invalidateQueries({ queryKey: KEY });
    }
  };
  return { yours, remember };
};
