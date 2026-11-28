/**
 * The review sheet's confirm label, and the line shown when a firm quote
 * moved: the first press asks the route again, and a change is said plainly
 * so the second look is not mistaken for a press that did nothing.
 */

export const PRICE_MOVED_NOTICE = 'the price moved · please look again';

export const reviewAction = (opts: { isFromZec: boolean; kind?: string }): string => {
  if (opts.isFromZec) {
    return opts.kind === 'zigner' ? 'sign with zigner' : 'swap';
  }
  return 'show deposit address';
};

export const reviewConfirmLabel = (opts: {
  isFromZec: boolean;
  kind?: string;
  askCustody?: boolean;
  priceMoved?: boolean;
}): string => {
  const action = reviewAction(opts);
  if (opts.priceMoved) {
    return `looks right · ${action}`;
  }
  return `${opts.askCustody ? 'understood · ' : ''}${action}`;
};
