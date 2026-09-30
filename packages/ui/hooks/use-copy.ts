import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Copies text to the clipboard and tracks a short "copied" state for
 * feedback. One hook, shared by every copy affordance in the app - never
 * call navigator.clipboard.writeText directly outside this hook.
 *
 * Never wire this to a seed phrase. Seed display keeps its blurred reveal
 * only - no copy, anywhere.
 */
export function useCopy(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), resetMs);
      });
    },
    [resetMs],
  );

  return { copied, copy };
}
