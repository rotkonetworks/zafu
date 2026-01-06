import { isZignerMessageEvent, type ZignerMessageEvent } from './zigner-message-event';

/** @note not private. could be observed by anything in this window. */
export const sendWindow = <P = never>(contents: NoInfer<P>) =>
  window.postMessage(
    { [ZIGNER]: contents } satisfies Record<typeof ZIGNER, P>,
    '/', // restrict to the same origin
    contents instanceof MessagePort ? [contents] : [],
  );

/** @note not private. could be activated by anything in this window. */
export const listenWindow = (
  signal: AbortSignal | undefined,
  listener: (pev: ZignerMessageEvent) => void,
) =>
  window.addEventListener(
    'message',
    ev => {
      if (
        isZignerMessageEvent(ev) && // only handle zigner messages
        ev.origin === window.origin && // from this origin
        ev.source === window // from this window
      ) {
        listener(ev);
      }
    },
    { signal },
  );
