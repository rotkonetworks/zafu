/**
 * Two quiet sounds, bundled with zafu and off until the person turns them on:
 * a small bell for a new line from someone, two wooden taps for money that
 * arrived. They play only while a zafu window is open; with every window
 * closed zafu reads nothing, so nothing could ring.
 */

import type { Thread } from '../people/vault';

export type Chime = 'message' | 'money';

/** lines from someone else that were not in the threads before: what a bell is for */
export const newIncoming = (
  before: Record<string, Thread>,
  after: Record<string, Thread>,
): number => {
  let n = 0;
  for (const [key, t] of Object.entries(after)) {
    const seen = new Set(before[key]?.items.map(i => i.hash));
    n += t.items.filter(i => !i.mine && i.kind !== 'note' && i.hash && !seen.has(i.hash)).length;
  }
  return n;
};

/**
 * One sound for every open zafu window: the popup and the side panel both hear
 * the same news, and only the first to take the lock plays it.
 */
export const play = (chime: Chime): void => {
  const ring = async () => {
    void new Audio(chrome.runtime.getURL(`sounds/${chime}.wav`)).play().catch(() => undefined);
    // held a moment, so the other window finds it taken; never longer, whatever play does
    await new Promise(r => setTimeout(r, 1_500));
  };
  void navigator.locks
    ?.request(`zafu-chime-${chime}`, { ifAvailable: true }, lock => (lock ? ring() : undefined))
    .catch(() => undefined);
};
