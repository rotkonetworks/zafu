/**
 * The four stages the sending screen shows, read off the zcash worker's own
 * progress labels (zcash-worker.ts emitProgress). Hot and PCZT builds share
 * the table; a label it does not know never moves the stage backwards.
 */
export const SEND_STAGES = [
  'selecting notes',
  'building witnesses',
  'proving',
  'broadcasting',
] as const;

export interface SendProgress {
  step: string;
  detail?: string;
}

const STAGE_OF: [match: RegExp, stage: number][] = [
  [/^(loading wallet state|fetching chain tip|selecting notes|notes selected)/, 0],
  [/^(building merkle witnesses|witnesses built|witness corrupt)/, 1],
  [
    /^(checking NU6\.3|NU6\.3 active|proving|building & proving|PCZT|unsigned|transaction proved)/,
    2,
  ],
  [/signed$/, 2],
  [/^broadcasting/, 3],
  [/^complete/, 4],
];

const stageOf = (step: string) => STAGE_OF.find(([m]) => m.test(step))?.[1];

/** the active stage (4 once complete); `floor` lifts it for device flows */
export const sendStage = (steps: readonly SendProgress[], floor = 0): number =>
  steps.reduce((s, p) => Math.max(s, stageOf(p.step) ?? s), floor);

const last = (steps: readonly SendProgress[], prefix: string) =>
  steps.findLast(p => p.step.startsWith(prefix));

/** the right-hand note on each stage row; '' when there is nothing true to say */
export const stageMeta = (steps: readonly SendProgress[], i: number, active: number): string => {
  if (i < active) {
    return 'done';
  }
  if (i === 0) {
    const n = /^(\d+)/.exec(last(steps, 'notes selected')?.detail ?? '')?.[1];
    return n ? `${n} note${n === '1' ? '' : 's'}` : '';
  }
  if (i === 1) {
    return last(steps, 'witness corrupt') ? 'rebuilding · about 3 min' : 'note tree';
  }
  if (i === 2 && i === active) {
    return last(steps, 'proving')?.detail ?? '';
  }
  return '';
};

/** one calm sentence for the active stage */
export const stageExplain = (steps: readonly SendProgress[], active: number, hot: boolean) =>
  [
    'choosing which of your private notes pay for this. nothing leaves your computer.',
    last(steps, 'witness corrupt')
      ? 'the note tree needs a deeper rebuild this time, about 3 min. thank you for waiting.'
      : 'showing each note exists in the zcash note tree, without saying which one.',
    hot
      ? 'your computer proves the payment is valid and signs it with your key. the network learns nothing about sender, amount or memo.'
      : 'your computer proves the payment is valid. the network learns nothing about sender, amount or memo.',
    'handing the finished transaction to the network.',
  ][Math.min(active, 3)]!;
