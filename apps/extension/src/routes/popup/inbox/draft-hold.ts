/**
 * A message sent as a memo leaves the thread for the send screen. If that send
 * fails and you come back, the text would be gone. Hold it here - in memory
 * only, for a minute - so the composer can offer it again. Dropped on a
 * successful send, and wiped when the minute is up so plaintext does not
 * linger.
 */

export const HOLD_MS = 60_000;

const held = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();

const drop = (threadId: string) => {
  const h = held.get(threadId);
  if (h) {
    clearTimeout(h.timer);
    held.delete(threadId);
  }
};

export const holdDraft = (threadId: string, text: string): void => {
  drop(threadId);
  held.set(threadId, { text, timer: setTimeout(() => held.delete(threadId), HOLD_MS) });
};

/** the held text for this thread, taken out of the hold */
export const takeDraft = (threadId: string): string | undefined => {
  const text = held.get(threadId)?.text;
  drop(threadId);
  return text;
};

/** a memo went out: forget any held draft it carried */
export const releaseDraft = (memo: string | undefined): void => {
  if (!memo) {
    return;
  }
  for (const [threadId, { text }] of held) {
    if (memo.includes(text)) {
      drop(threadId);
    }
  }
};
