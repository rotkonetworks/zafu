import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge, taught this project's type scale.
 *
 * Out of the box it does not know `text-hero` is a font size. It carries a
 * list of the built-in ones (text-xs ... text-9xl) and treats any other
 * `text-*` as a COLOUR - so in
 *
 *     cn('text-hero ... text-network-accent')
 *
 * both land in the same group, the later one wins, and the size is quietly
 * dropped. The class is right there in the source, absent from the DOM, and
 * nothing warns.
 *
 * That is how the zcash balance rendered at half the penumbra one through
 * three rounds of "but the classes are identical" - they were identical, and
 * only the penumbra span, a plain string that never went through cn, kept its
 * size. Every custom step had the same hole anywhere it met a text colour
 * inside cn, so this is not only about the balance.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['hero', 'display', 'title', 'body', 'data', 'label'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export const shorten = (str: string, endsLength = 4) =>
  str.length <= endsLength * 2 ? str : str.slice(0, endsLength) + '…' + str.slice(-endsLength);
