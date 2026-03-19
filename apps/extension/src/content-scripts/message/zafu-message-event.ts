//  the `data` payload of `ZafuMessageEvent<T>` is `{ [ZAFU]: T }`
const isZafuMessageEventData = (
  data?: unknown,
): data is Record<typeof ZAFU, NonNullable<unknown>> =>
  data != null &&
  typeof data === 'object' &&
  Object.keys(data).every(
    (key, index, allKeys) => key === ZAFU && index === 0 && allKeys.length === 1,
  ) &&
  (data as Record<typeof ZAFU, unknown>)[ZAFU] != null;

export type ZafuMessageEvent<T = unknown> = MessageEvent<Record<typeof ZAFU, NonNullable<T>>>;

export const isZafuMessageEvent = (ev?: unknown): ev is ZafuMessageEvent =>
  ev instanceof MessageEvent && isZafuMessageEventData(ev.data);

export const unwrapZafuMessageEvent = <T>(ev: ZafuMessageEvent<T>): T => {
  if (!isZafuMessageEventData(ev.data)) {
    throw new TypeError('Not a valid ZafuMessageEvent', { cause: ev });
  }
  // nullish values excluded by guard
  return ev.data[ZAFU]!;
};
