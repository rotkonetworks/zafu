import { useEffect, useState } from 'react';
import { TX_OP_PREFIX, readTxOps, sortOps, type TxOp } from '.';

/** Live list of tracked transactions, newest first. */
export const useTxOps = (): TxOp[] => {
  const [ops, setOps] = useState<TxOp[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void readTxOps()
        .then(list => {
          if (alive) {
            setOps(sortOps(list));
          }
        })
        .catch(() => undefined);
    load();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (Object.keys(changes).some(k => k.startsWith(TX_OP_PREFIX))) {
        load();
      }
    };
    chrome.storage.session.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.session.onChanged.removeListener(onChanged);
    };
  }, []);
  return ops;
};
