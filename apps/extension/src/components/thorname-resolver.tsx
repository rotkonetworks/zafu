/**
 * THORName resolver for a recipient field. Renders only while the field
 * holds something shaped like a name, on a chain thorchain has aliases for.
 * Nothing is looked up until the user presses "look up", never on typing.
 * Pressing the answer puts the address in the field.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/components/ui/button';
import { cn } from '@repo/ui/lib/utils';
import { isThorName, lookupThorName } from '../services/thorname';

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-5)}` : a);

export function ThorNameResolver({
  input,
  chain,
  onResolve,
}: {
  input: string;
  /** thorchain alias chain (ZEC, BTC, GAIA, ...); absent hides the resolver */
  chain?: string;
  onResolve: (address: string, name: string) => void;
}) {
  const name = input.trim();
  const on = chain ?? '';
  const candidate = !!on && isThorName(name);
  const [press, setPress] = useState<{ name: string; n: number }>();
  const asked = press?.name === name;
  const answer = useQuery({
    queryKey: ['thorname', name.toLowerCase(), on, asked ? press.n : 0],
    queryFn: () => lookupThorName(name, on),
    enabled: candidate && asked,
    staleTime: Infinity,
    retry: false,
  });

  if (!candidate) {
    return null;
  }

  const ask = () => setPress(p => ({ name, n: (p?.n ?? 0) + 1 }));
  const a = answer.data;
  const line = 'h-12 w-full justify-start gap-2.5 px-3.5 text-left';

  if (a?.kind === 'found') {
    return (
      <Button variant='secondary' className={line} onClick={() => onResolve(a.address, a.name)}>
        <span className='i-ph-at size-4 shrink-0 text-network-accent' aria-hidden='true' />
        <span className='truncate text-[13px]'>
          {a.name} · <span className='font-mono'>{short(a.address)}</span> · {a.chain.toLowerCase()}
        </span>
      </Button>
    );
  }

  const quiet: Partial<Record<NonNullable<typeof a>['kind'], string>> = {
    'no-alias': `${a?.kind === 'no-alias' ? a.name : name} has no ${on.toLowerCase()} address on thorchain`,
    missing: `no thorname is called ${name}`,
  };
  const said = a && quiet[a.kind];
  if (said) {
    return (
      <span className='flex h-12 items-center gap-2.5 border border-border-soft px-3.5 text-[13px] text-fg-muted'>
        <span className='i-ph-at size-4 shrink-0' aria-hidden='true' />
        <span className='truncate'>{said}</span>
      </span>
    );
  }

  const busy = answer.isFetching;
  return (
    <Button variant='secondary' className={line} onClick={ask} disabled={busy}>
      <span
        className={cn(
          'size-4 shrink-0',
          busy ? 'i-ph-spinner animate-spin' : 'i-ph-magnifying-glass text-fg-muted',
        )}
        aria-hidden='true'
      />
      <span className='truncate text-[13px]'>
        {a?.kind === 'error'
          ? 'thorchain did not answer · please try again'
          : `look up ${name} on thorchain`}
      </span>
    </Button>
  );
}
