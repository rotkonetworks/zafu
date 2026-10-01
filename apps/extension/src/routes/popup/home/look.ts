/**
 * What the shared home shows per network, as data. The accent is not here:
 * the popup layout sets `data-network`, which rebinds --network-accent
 * (gold for zcash, teal for penumbra) for everything under it.
 */
export interface HomeLook {
  /** the hero's unit, next to the figure */
  unit: string;
  /** heading of the balance rows */
  heading: string;
  /** the faint mark behind the hero (boards Main, HomePenumbra) */
  watermark: string;
  /** first-funds box */
  empty: string;
  receive: string;
  /** buying in from another asset, where the swap route exists */
  swapInto?: string;
}

export const HOME_LOOK = {
  zcash: {
    unit: 'zec',
    heading: 'balances',
    watermark: 'i-zafu-enso',
    empty: 'no zec yet',
    receive: 'receive zec',
    swapInto: 'swap into zec',
  },
  penumbra: {
    unit: 'um',
    heading: 'assets',
    watermark: 'i-zafu-enso',
    empty: 'no assets yet',
    receive: 'receive',
  },
} satisfies Record<string, HomeLook>;
