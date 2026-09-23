import { alreadyApprovedSender } from './approve';
import { isValidExternalSender, type ValidExternalSender } from './external';
import { type ValidInternalSender, isValidInternalSender } from './internal';

// Diagnostic dedup: an unapproved dapp reconnects on a loop, so the rejection
// below floods the console once per retry ("Session sender is not approved").
// Log a single actionable line PER sender identity naming who is connecting and
// whether it even has an approvable origin - so the culprit is visible without
// the flood. Does not change the security decision (the throw still rejects).
const loggedRejectedSenders = new Set<string>();

export const validateSessionPort = async (port: chrome.runtime.Port) => {
  if (isValidInternalSender(port.sender)) {
    return port as chrome.runtime.Port & { sender: ValidInternalSender };
  }

  if (isValidExternalSender(port.sender) && (await alreadyApprovedSender(port.sender))) {
    return port as chrome.runtime.Port & { sender: ValidExternalSender };
  }

  const who = port.sender?.origin ?? port.sender?.url ?? port.sender?.tab?.url ?? '(unknown)';
  if (!loggedRejectedSenders.has(who)) {
    loggedRejectedSenders.add(who);
    console.warn(
      `[session] rejecting unapproved session port from ${who} - it needs an approved connection to this wallet, or is not a valid dapp origin`,
      {
        origin: port.sender?.origin,
        url: port.sender?.url,
        tabUrl: port.sender?.tab?.url,
        looksExternal: isValidExternalSender(port.sender),
      },
    );
  }

  throw new Error('Session sender is not approved', { cause: port.sender });
};
