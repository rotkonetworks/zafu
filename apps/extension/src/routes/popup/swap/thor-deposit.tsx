/**
 * A thorchain swap out of zec, in flight: the fresh-address tracker in the
 * swap's words.
 */

import { FreshPayTracker } from '../../../components/fresh-pay-tracker';

type Props = Omit<Parameters<typeof FreshPayTracker>[0], 'to' | 'words'> & {
  /** the route's name, for the deposit leg */
  vault: string;
  onAgain: () => void;
};

export const ThorOutTracker = ({ vault, ...p }: Props) => (
  <FreshPayTracker
    {...p}
    to={vault}
    words={{
      noun: 'swap',
      move: "move zec to the swap's address",
      pay: `send to the ${vault} vault`,
      sits: "the zec sits on this swap's address,",
      notPaid: 'nothing went to the vault',
      held: 'the move is in · the deposit waits for your signature',
      resume: 'sign the swap',
      shows: "public · the amount, the vault and this swap's address show",
    }}
  />
);
