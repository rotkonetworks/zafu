import { useCallback } from 'react';
import { useStore } from '../../../state';
import { memberName, wordName } from '../../../people/word-name';
import type { PeopleRoom } from '../../../people/vault';

/**
 * How a group member is called on this device: your contact's name for
 * them, then the name they chose in this group (the one on their line, or
 * the founder's roster), then the word name made from their key here.
 *
 * Room keys are per group, so a contact matches only by a key you hold for
 * them; until a link from a group key to a contact exists, that is rare.
 */
export const useMemberName = (room: PeopleRoom | undefined) => {
  const contacts = useStore(s => s.contacts.contacts);
  const names = room?.group?.names;
  return useCallback(
    (key: string, lineName?: string): string => {
      const saved = (Array.isArray(contacts) ? contacts : []).find(c => c.zid === key)?.name;
      // a line names its author when they chose that name; else the roster does
      const word = wordName(key);
      const own = memberName(key, lineName);
      return memberName(key, own !== word ? own : names?.[key], saved);
    },
    [contacts, names],
  );
};
