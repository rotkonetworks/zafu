/**
 * One QR round with zigner, outside any one screen: show a request, scan the
 * device's answer, hand back the signed PCZT. The send screen keeps its own
 * round; the swap deposit (two rounds: fund the swap's address, then the
 * deposit) and lp.html share this one, so the display and scan steps read the
 * same everywhere.
 *
 * Built on the suspended signer (zigner-signer.ts): `sign` parks until
 * `answer` (or `cancel`) settles it. The surface that calls it must stay open
 * for the whole round, the same bar the send screen has.
 */

import { createStore } from 'zustand/vanilla';
import type { ExternalSigner } from './external-signer';
import { createZignerSigner } from './zigner-signer';
import { signedPcztOfAnswer } from './zigner-answer';

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
  let live: {
    req: ZignerRequest;
    deliver: (hex: string) => boolean;
    fail: (e: unknown) => boolean;
  } | null = null;

  /** show `req` (named by `label`) and wait for the signed PCZT, as hex */
  const sign = async (req: ZignerRequest, label: string): Promise<string> => {
    live?.fail(new ZignerDeclined());
    // eslint-disable-next-line @typescript-eslint/unbound-method -- createZignerSigner returns plain closures
    const { signer, deliver, fail } = createZignerSigner(() =>
      store.setState({ shown: { ...req, label }, scanning: false }),
    );
    const round = { req, deliver, fail };
    live = round;
    try {
      const out = await signer({ pcztHex: req.pcztHex, spendIndices: [], mainnet: true });
      if (out.kind !== 'signedPczt') {
        throw new Error('zigner answered in a shape zafu does not read here');
      }
      return out.pcztHex;
    } finally {
      if (live === round) {
        live = null;
        store.setState({ shown: null, scanning: false });
      }
    }
  };

  /** the same round as an ExternalSigner, for the shielded send tail (cold-send.ts) */
  const signer =
    (req: ZignerRequest, label: string): ExternalSigner =>
    async () => ({ kind: 'signedPczt', pcztHex: await sign(req, label) });

  /** the scanner read the device's answer */
  const answer = async (scanned: Uint8Array): Promise<void> => {
    const round = live;
    if (!round) {
      return;
    }
    try {
      round.deliver(
        await signedPcztOfAnswer(scanned, {
          compact: round.req.compactRequest === true,
          pcztHex: round.req.pcztHex,
          merge,
        }),
      );
    } catch (e) {
      round.fail(e instanceof Error ? e : new Error(String(e)));
    }
  };

  return {
    store,
    sign,
    signer,
    answer,
    scan: (scanning: boolean) => store.setState({ scanning }),
    /** step back: the parked round rejects with ZignerDeclined */
    cancel: () => live?.fail(new ZignerDeclined()),
  };
};

export type ZignerRound = ReturnType<typeof createZignerRound>;
