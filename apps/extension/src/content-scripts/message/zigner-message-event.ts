//  the `data` payload of `ZignerMessageEvent<T>` is `{ [ZIGNER]: T }`
const isZignerMessageEventData = (
  data?: unknown,
): data is Record<typeof ZIGNER, NonNullable<unknown>> =>
  data != null &&
  typeof data === 'object' &&
  Object.keys(data).every(
    (key, index, allKeys) => key === ZIGNER && index === 0 && allKeys.length === 1,
  ) &&
  (data as Record<typeof ZIGNER, unknown>)[ZIGNER] != null;

export type ZignerMessageEvent<T = unknown> = MessageEvent<Record<typeof ZIGNER, NonNullable<T>>>;

export const isZignerMessageEvent = (ev?: unknown): ev is ZignerMessageEvent =>
  ev instanceof MessageEvent && isZignerMessageEventData(ev.data);

export const unwrapZignerMessageEvent = <T>(ev: ZignerMessageEvent<T>): T => {
  if (!isZignerMessageEventData(ev.data)) {
    throw new TypeError('Not a valid ZignerMessageEvent', { cause: ev });
  }
  // nullish values excluded by guard
  return ev.data[ZIGNER]!;
};
