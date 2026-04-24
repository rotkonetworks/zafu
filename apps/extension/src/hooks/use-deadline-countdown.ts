import { useEffect, useState } from 'react';

/**
 * Live "seconds remaining" to a deadline timestamp (ms epoch).
 * Returns 0 once the deadline passes. Pass `null` to disable
 * (resets to 0 and stops ticking).
 *
 * Used by the FROST multisig flows to display one end-to-end
 * countdown for the whole session instead of per-round timers.
 */
export function useDeadlineCountdown(deadline: number | null): number {
  const [remaining, setRemaining] = useState(() =>
    deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0,
  );

  useEffect(() => {
    if (!deadline) { setRemaining(0); return; }
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [deadline]);

  return remaining;
}
