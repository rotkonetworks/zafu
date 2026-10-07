/**
 * One QR round with zigner, outside any one screen: show a request, scan the
 * device's answer, hand back the signed PCZT(s). The send screen keeps its own
 * round; a thorchain swap and lp.html share this one (one batch for the move
 * and the deposit that spends it), so the display and scan steps read the
 * same everywhere.
 *
 * `sign` (or `signBatch`) parks until `answer` (or `cancel`) settles it. The
 * surface that calls it must stay open for the whole round, the same bar the
 * send screen has.
 */

import { createStore } from 'zustand/vanilla';
import { signedPcztOfAnswer, signedPcztsOfBatchAnswer } from './zigner-answer';

/** what the worker built for zigner */
export interface ZignerRequest {
  /** the PCZT zafu keeps (a compact answer is merged into it) */
  readonly pcztHex: string;
  readonly urFrames: string[];
  /** the envelope the frames carry, to re-fountain at another density */
  readonly cborData?: Uint8Array;
  readonly cborBytes?: number;
  readonly compactRequest?: boolean;
}

export interface ZignerRoundState {
  /** the request on screen, and whether the camera is reading the answer */
  readonly shown: (ZignerRequest & { readonly label: string }) | null;
  readonly scanning: boolean;
}

/** the person stepped back from the round: nothing was signed or sent */
export class ZignerDeclined extends Error {
  constructor() {
    super('you stepped back before zigner signed · nothing was sent');
    this.name = 'ZignerDeclined';
  }
}

export const isZignerDeclined = (e: unknown): e is ZignerDeclined => e instanceof ZignerDeclined;

export const createZignerRound = (
  /** the worker's verifying merge, for a compact answer */
  merge: (pcztHex: string, contributionsJson: string) => Promise<string>,
) => {
  const store = createStore<ZignerRoundState>()(() => ({ shown: null, scanning: false }));
  interface Live {
    read: (scanned: Uint8Array) => Promise<void>;
    fail: (e: unknown) => void;
  }
  let live: Live | null = null;

  /** show `req` (named by `label`) and wait until `read` makes sense of the device's answer */
  const ask = <T>(
    req: ZignerRequest,
    label: string,
    read: (scanned: Uint8Array) => Promise<T>,
  ): Promise<T> => {
    live?.fail(new ZignerDeclined());
    let round!: Live;
    const done = new Promise<T>((resolve, reject) => {
      round = { read: scanned => read(scanned).then(resolve, reject), fail: reject };
    });
    live = round;
    store.setState({ shown: { ...req, label }, scanning: false });
    return done.finally(() => {
      if (live === round) {
        live = null;
        store.setState({ shown: null, scanning: false });
      }
    });
  };

  /** show `req` (named by `label`) and wait for the signed PCZT, as hex */
  const sign = (req: ZignerRequest, label: string): Promise<string> =>
    ask(req, label, scanned =>
      signedPcztOfAnswer(scanned, {
        compact: req.compactRequest === true,
        pcztHex: req.pcztHex,
        merge,
      }),
    );

  /** a full batch of `count` PCZTs, one scan each way: the signed PCZTs in request order */
  const signBatch = (req: ZignerRequest, count: number, label: string): Promise<string[]> =>
    ask(req, label, async scanned => signedPcztsOfBatchAnswer(scanned, count));

  return {
    store,
    sign,
    signBatch,
    /** the scanner read the device's answer */
    answer: async (scanned: Uint8Array): Promise<void> => live?.read(scanned),
    scan: (scanning: boolean) => store.setState({ scanning }),
    /** step back: the parked round rejects with ZignerDeclined */
    cancel: () => live?.fail(new ZignerDeclined()),
  };
};

export type ZignerRound = ReturnType<typeof createZignerRound>;
