/**
 * One cheap console line per penumbra phase, for timing a real send or a cold
 * start by hand. Filter the service worker console on `[penumbra-timing]`.
 * `@` is the worker's clock (ms since it woke), so gaps between phases show.
 */
export const penumbraTiming = (phase: string, since?: number) => {
  const now = performance.now();
  const took = since === undefined ? '' : ` ${Math.round(now - since)}ms`;
  console.log(`[penumbra-timing] ${phase}${took} @${Math.round(now)}ms`);
};
