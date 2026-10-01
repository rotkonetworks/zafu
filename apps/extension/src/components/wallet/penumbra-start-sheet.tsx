import { useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { localExtStorage } from '@repo/storage-chrome/local';
import { startsOf, type PenumbraStart } from '../../penumbra/start';
import { StartPresets } from './start-presets';

const DAY = 86_400_000;

const month = (ms: number) =>
  new Date(ms)
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    .toLowerCase();

/** the same choices the zcash birthday offers; the worker maps a date to a height */
const presets = (now = new Date()): { label: string; start: PenumbraStart; note: string }[] => {
  const y = now.getUTCFullYear();
  const since = (ms: number) => ({
    start: { since: ms },
    note: `reads the whole chain · yours from ${month(ms)}`,
  });
  return [
    { label: 'today', start: 'tip', note: 'starts now · nothing earlier will show' },
    { label: 'this week', ...since(now.getTime() - 7 * DAY) },
    { label: 'this month', ...since(Date.UTC(y, now.getUTCMonth(), 1)) },
    { label: 'this year', ...since(Date.UTC(y, 0, 1)) },
    { label: String(y - 1), ...since(Date.UTC(y - 1, 0, 1)) },
    { label: 'not sure', start: { since: 0 }, note: 'reads the whole chain · finds everything' },
  ];
};

/** a wallet's start, chosen once: never over one the worker already holds */
const choose = async (walletId: string, start: PenumbraStart) => {
  const starts = startsOf(await localExtStorage.get('penumbraStarts'));
  if (!starts?.[walletId]) {
    await localExtStorage.set('penumbraStarts', { ...starts, [walletId]: start });
  }
};

/** asked once per penumbra wallet, before its first sync */
export const PenumbraStartSheet = ({
  walletId,
  open,
  onClose,
}: {
  walletId: string | undefined;
  open: boolean;
  onClose: () => void;
}) => {
  const [options] = useState(presets);
  const [pick, setPick] = useState(3);

  return (
    <Sheet
      open={open}
      onOpenChange={o => !o && onClose()}
      title='when did you start using this wallet?'
    >
      <div className='flex flex-col gap-4'>
        <StartPresets labels={options.map(o => o.label)} pick={pick} onPick={setPick} />
        <span className='h-[18px] text-label text-fg-muted'>{options[pick]!.note}</span>
        <Button
          className='w-full'
          disabled={!walletId}
          onClick={() => {
            onClose();
            void choose(walletId!, options[pick]!.start);
          }}
        >
          continue
        </Button>
        <Button variant='quiet' className='w-full' onClick={onClose}>
          not now
        </Button>
      </div>
    </Sheet>
  );
};
