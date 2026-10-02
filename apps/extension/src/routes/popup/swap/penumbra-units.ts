/** penumbra amounts are u128 (lo + hi); every figure here keeps hi and stays exact */

import { joinLoHi } from '@penumbrafi/types/lo-hi';

interface LoHi {
  lo?: bigint;
  hi?: bigint;
}

/** one u128 amount as a bigint */
export const u128 = (a?: LoHi): bigint => joinLoHi(a?.lo, a?.hi);

/** what a simulated trade pays out: the last value of each trace, summed */
export const traceOut = (traces: readonly { value?: readonly { amount?: LoHi }[] }[] = []) =>
  traces.reduce((n, t) => n + u128(t.value?.at(-1)?.amount), 0n);
