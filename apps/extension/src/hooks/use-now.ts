import { useEffect, useState } from 'react';

/** the clock a wait shows: re-renders the caller every `ms` */
export const useNow = (ms = 1000): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
};
