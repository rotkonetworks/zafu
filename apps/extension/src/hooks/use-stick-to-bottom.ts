import { useEffect, useRef } from 'react';

/**
 * A chat's scroll: a new row snaps the view to the bottom only if the reader
 * was already there, or the new row is their own. Scrolled-up history, or a
 * room record changing an older card, never yanks the view.
 */
export const useStickToBottom = (rows: number, mine: boolean) => {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (el) {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }
  };
  useEffect(() => {
    if (stuck.current || mine) {
      ref.current?.scrollTo({ top: ref.current.scrollHeight });
    }
    // only a new row moves the view
  }, [rows]);
  return { ref, onScroll };
};
