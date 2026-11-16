import { useState, useEffect, useCallback } from 'react';
import { readTxNotes, TX_NOTES_KEY, writeTxNotes } from '../state/personal-data';

/**
 * Local, user-authored note attached to a transaction by txid.
 *
 * The chain cannot tell you who a shielded payment came FROM - an incoming note
 * reveals no sender. So a received tx is anonymous unless the user labels it
 * themselves ("rent from Alice"). These labels are:
 *   - purely local (never leave the wallet) and sealed at rest,
 *   - stored in chrome.storage.local, NOT the zcash IDB, so a resync / clear
 *     cache never erases them (same durability the 'sent' store now has), and
 *   - keyed by txid so they survive re-scans that rebuild the note set.
 */
const noteOf = (txid: string) =>
  readTxNotes().then(
    notes => notes[txid] ?? '',
    () => '',
  );

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
    const load = () =>
      void noteOf(txid).then(n => {
        if (alive) {
          setNote(n);
        }
      });
    load();
    // keep in sync if another surface (another popup) edits the same note;
    // the stored value is sealed, so it is read again rather than taken from the change
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area === 'local' && changes[TX_NOTES_KEY]) {
        load();
      }
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
      const notes = await readTxNotes();
      if (trimmed) {
        notes[txid] = trimmed;
      } else {
        delete notes[txid];
      }
      if (await writeTxNotes(notes, 'replace')) {
        setNote(trimmed);
      }
    },
    [txid],
  );

  return { note, save };
}
