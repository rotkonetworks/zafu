/**
 * Hands our extension id from the ISOLATED session script to the MAIN-world
 * penumbra script, which has no chrome.runtime. It used to sit on the page as
 * a `data-zafu-extension-id` attribute, where CSS selectors and session-replay
 * DOM snapshots could see it. An event pair dispatched within one call stack
 * leaves nothing behind, and it runs at document_start before any page script
 * can listen.
 */
const EVENT = 'zafu-extension-id';

/** ISOLATED: answer the first ask only, so a page cannot ask again later */
export const answerExtensionId = (id: string): void =>
  document.addEventListener(
    EVENT,
    () => document.dispatchEvent(new CustomEvent(EVENT, { detail: id })),
    { once: true },
  );

/** MAIN: our id, or '' when no live session script answered */
export const askExtensionId = (): string => {
  let id = '';
  const onAnswer = (ev: Event) => {
    const detail: unknown = (ev as CustomEvent<unknown>).detail;
    if (typeof detail === 'string') {
      id = detail;
    }
  };
  document.addEventListener(EVENT, onAnswer);
  document.dispatchEvent(new CustomEvent(EVENT));
  document.removeEventListener(EVENT, onAnswer);
  return id;
};
