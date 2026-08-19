import { useEffect } from 'react';
import { useCountdown } from 'usehooks-ts';

/**
 * A hook that counts down each second from a given number only when the window is focused.
 * If the window is out of focus, the countdown will reset and start from the beginning.
 *
 * @param countStart seconds to count down from. defaults to 0.5 (the anti
 *   fat-finger guard used by every approval screen).
 * @param intervalMs tick interval. defaults to 500 so the 0.5 default clears
 *   after ~500ms exactly as before; callers wanting whole-second countdowns
 *   (e.g. the 3s tx-approval delay) pass 1000.
 */
export const useWindowCountdown = (countStart = 0.5, intervalMs = 500) => {
  const [count, { startCountdown, stopCountdown, resetCountdown }] = useCountdown({
    countStart,
    countStop: 0,
    intervalMs,
    isIncrement: false,
  });

  const onFocus = () => {
    resetCountdown();
    startCountdown();
  };

  const onBlur = () => {
    stopCountdown();
  };

  useEffect(() => {
    if (document.hasFocus()) {
      startCountdown();
    }

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);

    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, [startCountdown]);

  return count;
};
