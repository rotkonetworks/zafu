import { isZafuMessageEvent, ZAFU_MSG_NS, type ZafuMessageEvent } from './zafu-message-event';

/** @note not private. could be observed by anything in this window. */
export const sendWindow = <P = never>(contents: NoInfer<P>) =>
  window.postMessage(
    { [ZAFU_MSG_NS]: contents } satisfies Record<typeof ZAFU_MSG_NS, P>,
    '/', // restrict to the same origin
    contents instanceof MessagePort ? [contents] : [],
  );

/** @note not private. could be activated by anything in this window. */
export const listenWindow = (
  signal: AbortSignal | undefined,
  listener: (pev: ZafuMessageEvent) => void,
) =>
  window.addEventListener(
    'message',
    ev => {
      if (
        isZafuMessageEvent(ev) && // only handle zafu messages
        ev.origin === window.origin && // from this origin
        ev.source === window // from this window
      ) {
        listener(ev);
      }
    },
    { signal },
  );
