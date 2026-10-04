/**
 * What the sending screen shows for one network's build, as data: the stage
 * names, which progress label belongs to which stage, the note on each row
 * and the sentence under them. Zcash reads its worker's labels
 * (zcash-worker.ts emitProgress), penumbra the service worker's op steps
 * (message/listen/penumbra-send.ts). A label a table does not know never
 * moves the stage backwards.
 */

export interface SendProgress {
  step: string;
  detail?: string;
}

export interface Stages {
  names: readonly string[];
  /** progress label -> stage; one past the last stage means complete */
  of: readonly (readonly [RegExp, number])[];
  /** the right-hand note on a row not yet done; '' when there is nothing true to say */
  note: (steps: readonly SendProgress[], i: number, active: number) => string;
  /** one calm sentence for the active stage */
  explain: (steps: readonly SendProgress[], active: number, hot: boolean) => string;
}

const last = (steps: readonly SendProgress[], prefix: string) =>
  steps.findLast(p => p.step.startsWith(prefix));

const NOTES_PAY =
  'choosing which of your private notes pay for this. nothing leaves your computer.';
const HAND_OFF = 'handing the finished transaction to the network.';

const zcash: Stages = {
  names: ['selecting notes', 'building witnesses', 'proving', 'broadcasting'],
  of: [
    [/^(loading wallet state|fetching chain tip|selecting notes|notes selected)/, 0],
    [/^(building merkle witnesses|witnesses built|catch-up)/, 1],
    [
      /^(checking NU6\.3|NU6\.3 active|proving|building & proving|PCZT|unsigned|transaction proved)/,
      2,
    ],
    [/signed$/, 2],
    [/^broadcasting/, 3],
    [/^complete/, 4],
  ],
  note: (steps, i, active) => {
    if (i === 0) {
      const n = /^(\d+)/.exec(last(steps, 'notes selected')?.detail ?? '')?.[1];
      return n ? `${n} note${n === '1' ? '' : 's'}` : '';
    }
    if (i === 1) {
      return last(steps, 'catch-up') ? 'catching up' : 'note tree';
    }
    return i === 2 && i === active ? (last(steps, 'proving')?.detail ?? '') : '';
  },
  explain: (steps, active, hot) =>
    [
      NOTES_PAY,
      last(steps, 'catch-up')
        ? 'catching up the note tree first, so this takes a little longer. thank you for waiting.'
        : 'showing each note exists in the zcash note tree, without saying which one.',
      hot
        ? 'your computer proves the payment is valid and signs it with your key. the network learns nothing about sender, amount or memo.'
        : 'your computer proves the payment is valid. the network learns nothing about sender, amount or memo.',
      HAND_OFF,
    ][Math.min(active, 3)]!,
};

/** the approval window opens during "approve and build"; proving runs after it */
const penumbra: Stages = {
  names: ['planning', 'approve and prove', 'broadcasting'],
  of: [
    [/^(sending to the wallet|preparing|planning)/, 0],
    [/^approve and build/, 1],
    [/^broadcasting/, 2],
  ],
  note: (_steps, i, active) => (i === 1 && i === active ? 'in the approval window' : ''),
  explain: (_steps, active) =>
    [
      NOTES_PAY,
      'please confirm it in the approval window. then your computer proves it, and the network learns nothing about sender, amount or memo.',
      HAND_OFF,
    ][Math.min(active, 2)]!,
};

/** a transparent chain reports no steps: one honest row while it signs and sends */
const cosmos: Stages = {
  names: ['signing and broadcasting'],
  of: [],
  note: () => '',
  explain: () =>
    'signing with your key, then handing it to the network. this chain is public, so the address and amount are visible.',
};

export const STAGES = { zcash, penumbra, cosmos } satisfies Record<string, Stages>;

const stageOf = (stages: Stages, step: string) => stages.of.find(([m]) => m.test(step))?.[1];

/** the active stage (names.length once complete); `floor` lifts it for device flows */
export const sendStage = (stages: Stages, steps: readonly SendProgress[], floor = 0): number =>
  steps.reduce((s, p) => Math.max(s, stageOf(stages, p.step) ?? s), floor);

export const stageMeta = (
  stages: Stages,
  steps: readonly SendProgress[],
  i: number,
  active: number,
): string => (i < active ? 'done' : stages.note(steps, i, active));
