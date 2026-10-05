/**
 * Times as the people screens say them: one place, so a card, a thread and
 * the relay slot all read alike.
 */

import { whenOf } from '../routes/popup/inbox/threads';

/** 14:05 */
export const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** 'today', 'yesterday', a weekday or a date (ms) */
export const dayOf = (ms: number) => {
  const w = whenOf(ms);
  return /^\d/.test(w) ? 'today' : w;
};

/** 'today 14:05', 'yesterday 09:12', 'oct 3 18:40' (ms) */
export const dayAt = (ms: number) => `${dayOf(ms)} ${hhmm(ms)}`;
