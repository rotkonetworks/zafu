// Static namespace key for zafu's window.postMessage envelopes. The value
// is just a label — the envelope key isn't a security boundary (anything
// in the page's window can read or send messages anyway). Kept as a plain
// string so ISOLATED and MAIN content scripts agree without a build-time
// constant; switching off the per-build `ZAFU` (extension-id) constant
// also fixes the Web Store / unpacked ID-mismatch breakage.
export const ZAFU_MSG_NS = 'zafu' as const;

//  the `data` payload of `ZafuMessageEvent<T>` is `{ [ZAFU_MSG_NS]: T }`
const isZafuMessageEventData = (
  data?: unknown,
): data is Record<typeof ZAFU_MSG_NS, NonNullable<unknown>> =>
  data != null &&
  typeof data === 'object' &&
  Object.keys(data).every(
    (key, index, allKeys) => key === ZAFU_MSG_NS && index === 0 && allKeys.length === 1,
  ) &&
  (data as Record<typeof ZAFU_MSG_NS, unknown>)[ZAFU_MSG_NS] != null;

export type ZafuMessageEvent<T = unknown> = MessageEvent<Record<typeof ZAFU_MSG_NS, NonNullable<T>>>;

export const isZafuMessageEvent = (ev?: unknown): ev is ZafuMessageEvent =>
  ev instanceof MessageEvent && isZafuMessageEventData(ev.data);

export const unwrapZafuMessageEvent = <T>(ev: ZafuMessageEvent<T>): T => {
  if (!isZafuMessageEventData(ev.data)) {
    throw new TypeError('Not a valid ZafuMessageEvent', { cause: ev });
  }
  // nullish values excluded by guard
  return ev.data[ZAFU_MSG_NS]!;
};
