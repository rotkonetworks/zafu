import { useState, useEffect, useCallback } from 'react';

/**
 * Local, user-authored note attached to a transaction by txid.
 *
 * The chain cannot tell you who a shielded payment came FROM - an incoming note
 * reveals no sender. So a received tx is anonymous unless the user labels it
 * themselves ("rent from Alice"). These labels are:
 *   - purely local (never leave the wallet),
 *   - stored in chrome.storage.local, NOT the zcash IDB, so a resync / clear
 *     cache never erases them (same durability the 'sent' store now has), and
 *   - keyed by txid so they survive re-scans that rebuild the note set.
 */
const STORE_KEY = 'txNotes';
type TxNotes = Record<string, string>;

export function useTxNote(txid: string | undefined): {
  note: string;
  save: (value: string) => Promise<void>;
} {
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!txid) {
      setNote('');
      return;
    }
    let alive = true;
    void chrome.storage.local.get(STORE_KEY).then(r => {
      if (!alive) {
        return;
      }
      const notes = (r[STORE_KEY] as TxNotes | undefined) ?? {};
      setNote(notes[txid] ?? '');
    });
    // keep in sync if another surface (another popup) edits the same note
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== 'local' || !changes[STORE_KEY]) {
        return;
      }
      const notes = (changes[STORE_KEY].newValue as TxNotes | undefined) ?? {};
      setNote(notes[txid] ?? '');
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, [txid]);

  const save = useCallback(
    async (value: string): Promise<void> => {
      if (!txid) {
        return;
      }
      const trimmed = value.trim();
      const r = await chrome.storage.local.get(STORE_KEY);
      const notes = (r[STORE_KEY] as TxNotes | undefined) ?? {};
      if (trimmed) {
        notes[txid] = trimmed;
      } else {
        delete notes[txid];
      }
      await chrome.storage.local.set({ [STORE_KEY]: notes });
      setNote(trimmed);
    },
    [txid],
  );

  return { note, save };
}
