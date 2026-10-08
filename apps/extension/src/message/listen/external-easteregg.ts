/**
 * external message listener - handles messages from websites via externally_connectable
 *
 * supports:
 * - { type: 'ping' } → responds with { zafu: true, version (connected sites only) }
 * - { type: 'send', address } → opens send popup
 * - { type: 'zafu_sign', challengeHex, ... } → sign request (handled elsewhere)
 * - { type: 'zafu_request_capability', capability } → request a specific capability
 * - { type: 'zafu_pick_contacts', purpose, max } → opens contact picker popup
 * - { type: 'zafu_pick_contacts_result', requestId, contacts } → internal: picker result
 * - { type: 'zafu_send_invite', handle, payload } → route invite via e2ee
 * - { type: 'zafu_frost_create' } → create FROST DKG, returns approval popup
 * - { type: 'zafu_frost_join', roomCode } → join existing FROST DKG
 * - { type: 'zafu_frost_sign', roomCode, sighashHex, ... } → FROST signing session
 * - { type: 'zafu_dkg_join', relayUrl, roomCode, threshold, maxSigners, labelPrefix? }
 *     → join an existing DKG room with the current zafu protocol (R1:T:N:SK + FVK echo);
 *       persists multisig labeled "<labelPrefix>-YYYY-MM-DD-HHMM" (defaults to origin host)
 * - { type: 'zafu_frost_sign_orchard', relayUrl, roomCode, plan, feeZat, multisigLabel? }
 *     → join an Orchard PCZT signing room as a peer (INIT-MULTI/COMMITS/SHARE wire tags);
 *       popup shows the plan (outputs + fee), runs round-1/round-2 over the relay,
 *       caller (host) aggregates + broadcasts.
 * - { type: 'zafu_delete_multisig', multisigLabel, delayMs? }
 *     → schedule (or immediately do) deletion of a multisig vault by name prefix.
 *       used by app-driven multisigs (poker tables) to evaporate themselves after settlement.
 *       no popup - silent operation. delayMs default 0 (immediate).
 * - { type: 'zafu_open_shield', chainId } → show the wallet's own shield-in screen
 *     (dapp handoff, e.g. Veil's "deposit from Injective"); nothing crosses back.
 */

import { DEFAULT_RELAY_URL } from '../../config/multisig-relay';
import { getOriginPermissions, grantCapability, denyCapability } from '@repo/storage-chrome/origin';
import { getCapabilityMode, setCapabilityMode } from '../../state/capability-modes';
import {
  decideCapabilityUse,
  isOptinPending,
  modeFromOptin,
} from '../../utils/capability-decision';
import {
  hasCapability,
  isDenied,
  type Capability,
  CAPABILITY_META,
} from '@repo/storage-chrome/capabilities';
import {
  nextHdIndex,
  checkAndBumpFreshAddressRateLimit,
} from '@repo/storage-chrome/cosmos-chain-counters';
import { COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import { isValidExternalSender, type ValidExternalSender } from '../../senders/external';
import { isValidInternalSender } from '../../senders/internal';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { grantsFor, readPasskeyGrants, recordPasskeyGrant } from '../../state/passkey-grants';
import type { Credential } from '../../state/webauthn';
import type { KeyInfo } from '../../state/keyring/types';
import { clientDataJson } from '../../content-scripts/passkey-wire';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { ZAFU_PROTOCOL_VERSION, ZAFU_SUPPORTED_PROTOCOL_VERSIONS } from '@zafu/protocol';
import { getApprovalSurface } from '../../side-panel-pref';
import { isSidePanelOpen } from '../../side-panel-presence';
import { SIDE_PANEL_NAVIGATE } from '../side-panel-delivery';
import { popupWindowGeometry } from '../../utils/popup-window';
import { PopupPath } from '../../routes/popup/paths';

/**
 * Show a wallet route on the user's chosen surface: navigate the side panel
 * when it is open in the window they are looking at (and they haven't opted
 * out of side-panel approvals), otherwise open a popup window. Same routing
 * rule as the unlock flow in needs-login.ts, so the wallet - not the dapp -
 * decides where its UI appears. The popup path goes through the per-origin
 * guard below (one wallet window per site at a time), so a page cannot spam
 * windows. Returns false when a window for this origin is already open.
 */
export const openWalletRoute = async (origin: string, route: string): Promise<boolean> => {
  const win = await chrome.windows
    .getLastFocused({ windowTypes: ['normal'] })
    .catch(() => undefined);
  const inPanel = (await isSidePanelOpen(win?.id)) && (await getApprovalSurface()) !== 'popup';
  if (inPanel) {
    await chrome.runtime.sendMessage({ type: SIDE_PANEL_NAVIGATE, route });
    return true;
  }
  const url = new URL(chrome.runtime.getURL('/popup.html'));
  url.hash = route;
  return openApprovalPopup(origin, url.href);
};

/** Source chains the wallet can shield from via zafu_open_shield. */
const OPEN_SHIELD_CHAINS = new Set<string>(['injective']);

// The v1 methods this listener routes to a real handler here (vs delegating to
// sign-request.ts / external-encryption.ts) are enumerated as EASTEREGG_V1_METHODS
// in the zafu-method-names leaf. Keep the switch below in sync with that list;
// the protocol contract test fails on drift.

// Gates the zafu_frost_sign_orchard external entry. The joiner now receives
// a full PCZT from the host and verifies sighash + OVK-decrypted outputs
// on zigner before signing (gh #17), so the display↔sighash binding gap
// is closed. Enabled.
const ENABLE_FROST_SIGN_ORCHARD = true;

// pending pick requests: requestId → sendResponse callback
const pendingPicks = new Map<string, (r: unknown) => void>();

/** is the wallet locked right now? read before an unlock, so a request knows it made the person type their password */
const walletLocked = async (): Promise<boolean> => !(await sessionExtStorage.get('passwordKey'));

/**
 * Register a pending popup callback keyed by `requestId`. Other external
 * listeners that open an approval window (e.g. the contact-discovery consent
 * request) share this registry so they inherit the SAME lifecycle: resolved by
 * their internal result message, or - if the user closes the window without
 * deciding - by the `chrome.windows.onRemoved` sweep below with the cancelled
 * shape. Kept here rather than duplicated so the per-origin guard and the
 * onRemoved cleanup stay a single implementation.
 */
export const registerPendingApproval = (requestId: string, cb: (r: unknown) => void): void => {
  pendingPicks.set(requestId, cb);
};

/**
 * Take (and remove) the pending callback for `requestId`, if any. The caller
 * owns invoking it exactly once; used by an internal result listener.
 */
export const takePendingApproval = (requestId: string): ((r: unknown) => void) | undefined => {
  const cb = pendingPicks.get(requestId);
  pendingPicks.delete(requestId);
  return cb;
};

// Origins that currently have an approval popup open. A second high-risk
// request from the same origin is dropped while one is pending so a site
// can't stack approval popups to fatigue the user into approving (gh #19).
// Reserved synchronously at open time; released when the popup window closes.
const originsWithOpenPopup = new Set<string>();
const popupWindowToOrigin = new Map<number, string>();

// Tracks popup windowId -> pending pendingPicks requestId so a user closing
// the popup without deciding fires the pending callback with a cancelled shape
// rather than leaving the caller's message channel open until the runtime
// times it out ("channel closed before response received"). Registered right
// after chrome.windows.create resolves so pendingPicks is set FIRST at the
// callsite; that ordering removes the race where the window closes between
// windowId registration and pendingPicks.set.
const popupWindowToRequestId = new Map<number, string>();

// Reverse of popupWindowToRequestId, so a result message (which only carries
// the requestId) can release the per-origin guard immediately - see
// releasePopupGuardForRequest below.
const requestIdToWindowId = new Map<string, number>();

/**
 * Release the per-origin popup-open guard for `requestId`'s window as soon
 * as its result is IN, instead of waiting for the physical window-close
 * event. A flow that opens two approval popups back to back for the SAME
 * origin - the global opt-in question (askOptin), immediately followed by
 * the per-site consent (requestCapabilityApprovalPopup) - would otherwise
 * race `onRemoved`: that event fires only once Chrome finishes tearing the
 * window down, which is frequently AFTER the service worker has already
 * resumed and tried to open the second popup, so the still-set guard from
 * the first popup would silently drop the second one (gh: the global
 * question is answered but the per-site one never appears). Releasing here,
 * at the point a decision is consumed, removes that race. `onRemoved` is
 * still the ONLY cleanup for a window closed without ever answering (no
 * result message ever arrives in that case).
 */
function releasePopupGuardForRequest(requestId: string): void {
  const windowId = requestIdToWindowId.get(requestId);
  if (windowId === undefined) {
    return;
  }
  requestIdToWindowId.delete(requestId);
  popupWindowToRequestId.delete(windowId);
  const origin = popupWindowToOrigin.get(windowId);
  if (origin !== undefined) {
    popupWindowToOrigin.delete(windowId);
    originsWithOpenPopup.delete(origin);
  }
}

// A result message races the window removal: the approval popup sends its
// approve/deny message and then closes itself, and `onRemoved` can win. Settling
// a pending entry the instant the window disappears therefore threw away
// approvals the user HAD given - the caller saw the cancelled shape, the content
// script fell back to the platform authenticator, and the credential was never
// minted even though the user pressed approve. Hold the cancellation briefly so
// that a result already in flight can still claim the entry; a genuine close
// without deciding is only reported late, never lost.
const CLOSED_WINDOW_GRACE_MS = 1000;

// optional-chained: chrome.windows is absent in unit-test mocks, and this
// runs at module load, so guard it rather than crash the import.
chrome.windows?.onRemoved?.addListener(windowId => {
  const origin = popupWindowToOrigin.get(windowId);
  if (origin !== undefined) {
    popupWindowToOrigin.delete(windowId);
    originsWithOpenPopup.delete(origin);
  }
  const requestId = popupWindowToRequestId.get(windowId);
  // delete by windowId - the map is keyed by the window, so deleting by
  // requestId left every entry behind and a reused window id could later
  // cancel an unrelated request.
  popupWindowToRequestId.delete(windowId);
  if (requestId === undefined) {
    return;
  }
  setTimeout(() => {
    // the result listeners take the entry synchronously when their message
    // arrives, so an entry that is still here means the user never decided.
    const cb = takePendingApproval(requestId);
    if (!cb) {
      return;
    }
    // Shape doubles for two callback flavours:
    //  - FROST / pick_contacts / zcash_send sendResponse: they read `success`
    //    and treat this as a cancelled/denied outcome.
    //  - zafu_request_capability's resolve(): reads `cancelled` and skips
    //    denyCapability (a persistent deny the user never made would be a
    //    semantics change).
    cb({ success: false, error: 'cancelled', cancelled: true });
  }, CLOSED_WINDOW_GRACE_MS);
});

/**
 * Open an approval popup bound to `origin`, dropping the request if that
 * origin already has one open. Returns false (caller must reject) when a
 * popup is already pending for the origin; true once the window has been
 * created. Released on window close via the onRemoved listener above.
 */
export async function openApprovalPopup(
  origin: string,
  url: string,
  requestId?: string,
): Promise<boolean> {
  if (originsWithOpenPopup.has(origin)) {
    return false;
  }
  originsWithOpenPopup.add(origin);
  const geometry = await popupWindowGeometry();
  try {
    const opened = await createPopupWindow(url, geometry);
    if (opened?.id !== undefined) {
      popupWindowToOrigin.set(opened.id, origin);
      if (requestId !== undefined) {
        popupWindowToRequestId.set(opened.id, requestId);
        requestIdToWindowId.set(requestId, opened.id);
      }
      return true;
    }
    // No trackable windowId: the onRemoved sweep can never fire, so the
    // caller would hang forever. Treat as failure - the callsite emits its
    // denied shape and releases the pending entry.
    originsWithOpenPopup.delete(origin);
    return false;
  } catch {
    originsWithOpenPopup.delete(origin);
    return false;
  }
}

/**
 * Create the window, retrying once without the anchor. Chrome refuses a window
 * placed less than half inside the visible screen, and the anchor is computed
 * from the browser window's geometry - which can legitimately sit off-screen.
 * The size (420x760, the whole point: approval screens must not clip their
 * Approve/Deny row) is kept on the retry.
 */
const createPopupWindow = async (
  url: string,
  geometry: { width: number; height: number; top: number; left: number },
): Promise<chrome.windows.Window | undefined> => {
  try {
    return await chrome.windows.create({ url, type: 'popup', focused: true, ...geometry });
  } catch {
    return chrome.windows.create({
      url,
      type: 'popup',
      focused: true,
      width: geometry.width,
      height: geometry.height,
    });
  }
};

/**
 * Uniform capability gate for high-risk external entry points.
 *
 * Any rejection - missing origin, missing perms, missing capability,
 * lookup error - returns the same error shape after a constant minimum
 * latency. Differentiating rejection causes (which the older
 * zafu_passkey_* pattern does) gives a local attacker a fingerprint of
 * which capabilities a user has granted; uniform rejection collapses
 * those distinguishable paths.
 *
 * Callers receive either:
 *   { ok: true, origin: <validated origin> } - proceed
 *   null - sendResponse has been
 *                                                 called with the denied
 *                                                 shape; caller MUST
 *                                                 early-return.
 */
const REJECT_FLOOR_MS = 30;
async function requireCapability(
  sender: chrome.runtime.MessageSender,
  cap: Capability,
  sendResponse: (r: unknown) => void,
): Promise<{ ok: true; origin: string } | null> {
  const start = performance.now();
  const reject = async () => {
    const elapsed = performance.now() - start;
    if (elapsed < REJECT_FLOOR_MS) {
      await new Promise<void>(r => setTimeout(r, REJECT_FLOOR_MS - elapsed));
    }
    // NOTE: deliberately NO `code` field here. This is the uniform rejection
    // shape for the high-risk FROST/multisig gate (gh #18): every rejection -
    // whatever the cause - must be byte-identical so a caller cannot distinguish
    // which stage refused (that would leak, e.g., a label-length hint). Adding a
    // structured code belongs only on the dapp-facing encryption surface
    // (external-encryption.ts), which has no such uniformity requirement.
    sendResponse({ success: false, error: 'denied' });
    return null;
  };

  const origin = sender.origin || sender.url || '';
  if (!origin) {
    return reject();
  }
  try {
    // Global participation first: a capability the user turned off (or is
    // still undecided about, which prompts once) collapses into the same
    // uniform rejection as a missing per-origin grant - the caller cannot
    // tell a global refusal from a per-origin one.
    const modeCheck = await ensureCapabilityMode(cap, origin);
    if (!modeCheck.ok) {
      return reject();
    }
    const perms = await getOriginPermissions(origin);
    if (!hasCapability(perms, cap)) {
      return reject();
    }
  } catch {
    return reject();
  }
  return { ok: true, origin };
}

/**
 * Global participation switch, consulted before any per-origin consent.
 *
 * The per-origin capability grant answers "may THIS site use this?"; this
 * answers "does the user want zafu to offer this at all?". An undecided
 * capability (absent from storage) is asked ONCE, globally - the question is
 * not about the site, so the screen gets no origin - and the answer is
 * persisted as the mode, so every later site skips straight to its own
 * per-origin consent. A cancelled prompt persists nothing, so a site whose
 * approval window died cannot lock the feature out.
 *
 * Returns `cancelled` for a prompt the user never answered: callers must not
 * report a denial the user did not make.
 */
type ModeCheck = { ok: true } | { ok: false; reason: 'disabled' | 'cancelled' };
interface OptinAnswer {
  approved: boolean;
  cancelled: boolean;
}

/**
 * Open the one-time global question (`scope=zafu`, no origin shown) and return
 * the raw answer. Persisting is the caller's business: the same answer means
 * "set the mode" in the worker and nothing at all in a popup.
 */
async function askOptin(origin: string, cap: Capability): Promise<OptinAnswer> {
  const requestId = crypto.randomUUID();
  const resultPromise = new Promise<unknown>(resolve => {
    pendingPicks.set(requestId, resolve);
  });
  const params = new URLSearchParams({ capability: cap, requestId, scope: 'zafu' });
  const url = chrome.runtime.getURL(`popup.html#/approval/capability?${params.toString()}`);
  if (!(await openApprovalPopup(origin, url, requestId))) {
    pendingPicks.delete(requestId);
    return { approved: false, cancelled: true };
  }
  const result = (await resultPromise) as { approved?: boolean; cancelled?: boolean } | undefined;
  if (result?.cancelled) {
    return { approved: false, cancelled: true };
  }
  return { approved: result?.approved === true, cancelled: false };
}

async function ensureCapabilityMode(cap: Capability, origin: string): Promise<ModeCheck> {
  const mode = await getCapabilityMode(cap);
  if (!isOptinPending(mode)) {
    return mode === 'enabled' ? { ok: true } : { ok: false, reason: 'disabled' };
  }
  const answer = await askOptin(origin, cap);
  if (answer.cancelled) {
    return { ok: false, reason: 'cancelled' };
  }
  // A denial is sticky, exactly like answering the per-site prompt: asking the
  // same question again on every page load is the nagging this switch exists to
  // prevent. Settings is where it is turned back on.
  await setCapabilityMode(cap, modeFromOptin(answer.approved));
  return answer.approved ? { ok: true } : { ok: false, reason: 'disabled' };
}

/**
 * Open the per-origin capability approval popup and wait for a decision,
 * granting/denying `cap` at `origin` as a side effect. This is the ONE
 * place that opens that popup - both `zafu_request_capability`'s popup
 * path and `zafu_passkey_get`'s re-authorization-after-expiry path (see
 * TIME_LIMITED_CAPABILITIES) call this instead of each running their own
 * copy of the window-lifecycle plumbing.
 *
 * Goes through `openApprovalPopup`, same as every other high-risk popup in
 * this file, so a second concurrent request from the same origin (e.g. a
 * page looping `navigator.credentials.get()`) is dropped instead of
 * stacking another window - `openApprovalPopup` is the per-origin
 * `originsWithOpenPopup` guard (gh #19); opening the window directly here
 * used to bypass it.
 *
 * Returns which of the three outcomes happened, since callers respond
 * differently to "the user said no" than to "the popup never got an
 * answer" (closed, failed to open, or dropped by the per-origin guard): a
 * cancelled decision must NOT persist a denial the user never made.
 */
export async function requestCapabilityApprovalPopup(
  origin: string,
  cap: Capability,
  sender: chrome.runtime.MessageSender,
): Promise<'approved' | 'denied' | 'cancelled'> {
  const requestId = crypto.randomUUID();
  const resultPromise = new Promise<unknown>(resolve => {
    pendingPicks.set(requestId, resolve);
  });

  const params = new URLSearchParams({
    app: origin,
    capability: cap,
    requestId,
    title: sender.tab?.title || '',
  });
  const url = chrome.runtime.getURL(`popup.html#/approval/capability?${params.toString()}`);
  if (!(await openApprovalPopup(origin, url, requestId))) {
    pendingPicks.delete(requestId);
    return 'cancelled';
  }

  const result = (await resultPromise) as { approved?: boolean; cancelled?: boolean };
  if (result?.approved) {
    await grantCapability(origin, cap);
    return 'approved';
  }
  if (result?.cancelled) {
    // Popup never got a user decision (closed or failed to open). Do NOT
    // persist a denial the user did not make; caller can retry.
    return 'cancelled';
  }
  await denyCapability(origin, cap);
  return 'denied';
}

interface PasskeyRefusal {
  success: false;
  error?: string;
  code?: string;
}

/**
 * A passkey request comes only through zafu's own content-script bridge, which
 * asks only after a click and backs off after "not now". The
 * externally_connectable door has no click to check, so it gets no passkeys.
 */
const passkeySender = (sender: chrome.runtime.MessageSender): sender is ValidExternalSender =>
  sender.id === chrome.runtime.id && isValidExternalSender(sender);

/**
 * a tap the person did not give: `denied` said not now, `cancelled` never
 * answered. `busy` (this site's window is already open) carries no code: the
 * person declined nothing, so the page must not back off for it.
 */
const declined = (outcome: 'denied' | 'cancelled' | 'busy'): PasskeyRefusal =>
  outcome === 'busy'
    ? { success: false, error: 'denied' }
    : { success: false, error: outcome, code: outcome };

/**
 * The passkey switch is on and the wallet is unlocked, both asked for before
 * any passkey screen opens so a tap never lands on a wallet that cannot act.
 * `verified`: this request made the person enter their password (sets UV);
 * a tap on an unlocked wallet is presence, not verification.
 */
async function passkeyReady(
  origin: string,
): Promise<{ ok: true; verified: boolean } | { ok: false; refusal: PasskeyRefusal }> {
  const mode = await ensureCapabilityMode('passkey', origin);
  if (!mode.ok) {
    return {
      ok: false,
      refusal:
        mode.reason === 'cancelled' ? declined('cancelled') : { success: false, error: 'denied' },
    };
  }
  const verified = await walletLocked();
  try {
    const { throwIfNeedsLogin } = await import('../../needs-login');
    await throwIfNeedsLogin();
  } catch {
    return { ok: false, refusal: declined('cancelled') };
  }
  return { ok: true, verified };
}

/**
 * One tap in zafu for one passkey request. Goes through openApprovalPopup, so
 * a site gets one passkey window at a time. rpId and wallet ride along for
 * display only: the worker keeps its own copies and acts on those.
 */
async function askPasskeyTap(
  kind: 'create' | 'get',
  origin: string,
  rpId: string,
  walletId: string,
): Promise<'approved' | 'denied' | 'cancelled' | 'busy'> {
  const requestId = crypto.randomUUID();
  const decided = new Promise<{ approved?: boolean; cancelled?: boolean } | undefined>(resolve =>
    pendingPicks.set(requestId, r => resolve(r as { approved?: boolean; cancelled?: boolean })),
  );
  const params = new URLSearchParams({
    mode: kind,
    app: origin,
    rp: rpId,
    wallet: walletId,
    requestId,
  });
  const url = chrome.runtime.getURL(`popup.html#/passkey-approve?${params.toString()}`);
  if (!(await openApprovalPopup(origin, url, requestId))) {
    pendingPicks.delete(requestId);
    return 'busy';
  }
  const r = await decided;
  return r?.approved ? 'approved' : r?.cancelled ? 'cancelled' : 'denied';
}

/** after a tap: the site may ask again, for this rpId and account, answered by this wallet */
async function grantPasskey(
  origin: string,
  rpId: string,
  wallet: KeyInfo,
  userId: Uint8Array | undefined,
): Promise<void> {
  const { pocketOwner } = await import('../../state/pockets');
  await grantCapability(origin, 'passkey');
  await recordPasskeyGrant({
    origin,
    rpId,
    owner: pocketOwner(wallet),
    ...(userId?.length ? { userId: bytesToHex(userId) } : {}),
  });
}

/** the hex credential ids a relying party listed */
const credentialIds = (list: unknown): string[] =>
  Array.isArray(list)
    ? list
        .map((c: { id?: unknown } | null) => c?.id)
        .filter((id): id is string => typeof id === 'string')
    : [];

export const externalMessageListener = (
  req: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
) => {
  if (typeof req !== 'object' || req === null || !('type' in req)) {
    sendResponse({ error: 'invalid message' });
    return true;
  }

  const msg = req as Record<string, unknown>;
  const type = msg['type'] as string;

  // INTERNAL popup->worker result callbacks: accept ONLY from the extension
  // itself, never a web page (a page that guessed a requestId could otherwise
  // self-deliver a forged approval / picked contacts).
  const INTERNAL_RESULT_TYPES = new Set([
    'zafu_pick_contacts_result',
    'zafu_frost_result',
    'zafu_capability_result',
    'zafu_zcash_send_result',
    'zafu_passkey_result',
  ]);
  if (INTERNAL_RESULT_TYPES.has(type)) {
    // a content script carries this extension's id too, so the id alone is not
    // "zafu's own page": require the extension origin
    if (!isValidInternalSender(sender)) {
      return false;
    }
  } else if (
    // Public methods that open a popup or act on the user's behalf require a
    // valid top-frame https sender. Without this a third-party IFRAME could raise
    // a picker/approval/send popup wearing the host tab's identity (provenance
    // spoof). The frost/passkey entries already gate via requireCapability /
    // isValidExternalSender; ping is a harmless discovery response.
    (type === 'send' ||
      type === 'zafu_pick_contacts' ||
      type === 'zafu_request_capability' ||
      type === 'zafu_zcash_send') &&
    !isValidExternalSender(sender)
  ) {
    sendResponse({ success: false, error: 'denied', code: 'denied' });
    return true;
  }

  switch (type) {
    case 'ping': {
      // the release version narrows down who someone is; a site the person
      // connected may read it, any other gets an empty string (the shape the
      // protocol pins) and only the protocol versions it needs to talk to us
      const origin = sender.origin;
      void (async () => {
        const connected =
          !!origin &&
          isValidExternalSender(sender) &&
          hasCapability(await getOriginPermissions(origin), 'connect');
        sendResponse({
          zafu: true,
          version: connected ? chrome.runtime.getManifest().version : '',
          protocolVersion: ZAFU_PROTOCOL_VERSION,
          protocolVersions: [...ZAFU_SUPPORTED_PROTOCOL_VERSIONS],
        });
      })().catch(() => sendResponse({ error: 'ping failed' }));
      return true;
    }

    case 'send': {
      const address = msg['address'];
      if (!address || typeof address !== 'string') {
        sendResponse({ error: 'address required' });
        return true;
      }
      const params = new URLSearchParams({ to: address });
      // optional zatoshi amount - zafu's send popup converts to ZEC for display
      const amountZat = Number(msg['amount_zat']);
      if (Number.isFinite(amountZat) && amountZat > 0) {
        params.set('amount_zat', String(Math.floor(amountZat)));
      }
      // optional memo. callers can drop `[primary]` (canonical) or `[self]` (alias) anywhere
      // in the memo and the send popup substitutes the user's oldest non-multisig Zcash UA.
      // Saves a separate "what's my address" round-trip; user can still edit before send.
      const memo = msg['memo'];
      // a valid top-frame https sender (checked above), so the origin is attested
      const origin = sender.origin ?? '';
      void (async () => {
        // `[primary]`/`[self]` put the person's own address in the memo the
        // site's recipient reads: only a site they connected may ask for that.
        // An unconnected site still gets its prefilled send, minus the tokens.
        const connected = hasCapability(await getOriginPermissions(origin), 'connect');
        if (typeof memo === 'string' && memo.length > 0 && memo.length <= 512) {
          const kept = connected ? memo : memo.replaceAll('[primary]', '').replaceAll('[self]', '');
          if (kept.trim()) {
            params.set('memo', kept);
          }
        }
        const url = chrome.runtime.getURL(`popup.html#/send?${params.toString()}`);
        void chrome.windows.create({ url, type: 'popup', width: 400, height: 628 });
        sendResponse({ ok: true });
      })().catch(() => sendResponse({ ok: false }));
      return true;
    }

    case 'zafu_pick_contacts': {
      const appOrigin = sender.origin || sender.url || 'unknown';
      const purpose = String(msg['purpose'] || 'pick contacts');
      const max = Number(msg['max']) || 1;
      const requestId = crypto.randomUUID();

      // store the callback - picker popup will send result via internal message
      pendingPicks.set(requestId, sendResponse);

      // open picker popup with params
      const params = new URLSearchParams({
        app: appOrigin,
        purpose,
        max: String(max),
        requestId,
      });
      const url = chrome.runtime.getURL(`popup.html#/pick-contacts?${params.toString()}`);
      // Track windowId -> requestId so the onRemoved sweep can fire the
      // pending callback if the user closes the popup; on create-failure /
      // untrackable id, respond with the denied shape rather than hang.
      chrome.windows
        .create({ url, type: 'popup', width: 400, height: 520 })
        .then(win => {
          if (win?.id !== undefined) {
            popupWindowToRequestId.set(win.id, requestId);
            return;
          }
          if (pendingPicks.delete(requestId)) {
            sendResponse({ success: false, error: 'denied' });
          }
        })
        .catch(() => {
          if (pendingPicks.delete(requestId)) {
            sendResponse({ success: false, error: 'denied' });
          }
        });

      // return true = async response (sendResponse called later from picker)
      return true;
    }

    case 'zafu_pick_contacts_result': {
      const requestId = String(msg['requestId'] || '');
      const callback = pendingPicks.get(requestId);
      if (callback) {
        callback({ success: true, contacts: msg['contacts'] || [] });
        pendingPicks.delete(requestId);
      }
      sendResponse({ ok: true });
      return true;
    }

    case 'zafu_send_invite': {
      // TODO: resolve handle → pubkey, open e2ee channel, deliver payload
      sendResponse({ sent: false, error: 'invite delivery not yet implemented in extension' });
      return true;
    }

    case 'zafu_frost_create': {
      // open FROST DKG approval popup - user confirms creating a multisig.
      void (async () => {
        try {
          const gate = await requireCapability(sender, 'frost', sendResponse);
          if (!gate) {
            return;
          }
          const threshold = Number(msg['threshold']) || 2;
          const maxSigners = Number(msg['maxSigners']) || 3;
          const relayUrl = String(msg['relayUrl'] || DEFAULT_RELAY_URL);
          const appOrigin = sender.origin || sender.url || 'unknown';
          const requestId = crypto.randomUUID();

          const params = new URLSearchParams({
            app: appOrigin,
            action: 'frost-create',
            threshold: String(threshold),
            maxSigners: String(maxSigners),
            relayUrl,
            requestId,
          });
          const url = chrome.runtime.getURL(`popup.html#/frost-approve?${params.toString()}`);
          // Register the pending callback BEFORE opening the popup so the
          // onRemoved sweep can find it if the window closes fast; clear it if
          // openApprovalPopup rejects the request.
          pendingPicks.set(requestId, sendResponse);
          if (!(await openApprovalPopup(appOrigin, url, requestId))) {
            pendingPicks.delete(requestId);
            sendResponse({ success: false, error: 'denied' });
            return;
          }
        } catch {
          // dynamic import / state read can throw; fall back to the uniform
          // denied shape so the message channel closes cleanly.
          sendResponse({ success: false, error: 'denied' });
        }
      })();
      return true;
    }

    case 'zafu_frost_join': {
      void (async () => {
        const gate = await requireCapability(sender, 'frost', sendResponse);
        if (!gate) {
          return;
        }
        const roomCode = String(msg['roomCode'] || '');
        if (!roomCode) {
          sendResponse({ success: false, error: 'denied' });
          return;
        }
        const threshold = Number(msg['threshold']) || 2;
        const maxSigners = Number(msg['maxSigners']) || 3;
        const relayUrl = String(msg['relayUrl'] || DEFAULT_RELAY_URL);
        const requestId = crypto.randomUUID();

        const params = new URLSearchParams({
          app: gate.origin,
          action: 'frost-join',
          roomCode,
          threshold: String(threshold),
          maxSigners: String(maxSigners),
          relayUrl,
          requestId,
        });
        const url = chrome.runtime.getURL(`popup.html#/frost-approve?${params.toString()}`);
        pendingPicks.set(requestId, sendResponse);
        if (!(await openApprovalPopup(gate.origin, url, requestId))) {
          pendingPicks.delete(requestId);
          sendResponse({ success: false, error: 'denied' });
          return;
        }
      })();
      return true;
    }

    case 'zafu_dkg_join': {
      void (async () => {
        const gate = await requireCapability(sender, 'frost', sendResponse);
        if (!gate) {
          return;
        }
        const roomCode = String(msg['roomCode'] || '');
        if (!roomCode) {
          sendResponse({ error: 'roomCode required' });
          return;
        }
        const threshold = Number(msg['threshold']) || 2;
        const maxSigners = Number(msg['maxSigners']) || 3;
        const relayUrl = String(msg['relayUrl'] || DEFAULT_RELAY_URL);
        const appOrigin = sender.origin || sender.url || 'unknown';
        // new URL() throws on non-URL strings (e.g. 'unknown'); fall back safely.
        let originHost = 'multisig';
        try {
          originHost = new URL(appOrigin).host || 'multisig';
        } catch {
          /* keep default */
        }
        const rawPrefix = String(msg['labelPrefix'] || originHost);
        const labelPrefix = rawPrefix.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'multisig';
        const requestId = crypto.randomUUID();

        const hide = msg['hide'] === true;
        const params = new URLSearchParams({
          app: gate.origin,
          action: 'dkg-join',
          roomCode,
          threshold: String(threshold),
          maxSigners: String(maxSigners),
          relayUrl,
          labelPrefix,
          requestId,
        });
        if (hide) {
          params.set('hide', '1');
        }
        const url = chrome.runtime.getURL(`popup.html#/frost-approve?${params.toString()}`);
        pendingPicks.set(requestId, sendResponse);
        if (!(await openApprovalPopup(gate.origin, url, requestId))) {
          pendingPicks.delete(requestId);
          sendResponse({ error: 'denied' });
          return;
        }
      })();
      return true;
    }

    case 'zafu_frost_sign': {
      // DISABLED - this was unconditional blind signing.
      //
      // The approval screen for this entry showed only a truncated sighash:
      // no PCZT, no outputs, no verification of any kind. A page holding the
      // 'frost' capability could therefore get a threshold share released over
      // an arbitrary 32 bytes it chose. Worse, the caller's randomizer was set
      // equal to the message (alphas = [sighashHex]) - an attacker-chosen
      // randomizer over an attacker-chosen message is exactly the adaptive
      // setting randomized FROST exists to exclude.
      //
      // The safety posture was inverted: the VERIFIED orchard path sits behind
      // ENABLE_FROST_SIGN_ORCHARD while this unverifiable one had no gate at
      // all. Use zafu_frost_sign_orchard, which publishes the PCZT and runs
      // the co-signer verdict before anything is signed.
      sendResponse({
        success: false,
        error:
          'zafu_frost_sign is disabled: it signed an unverifiable digest. ' +
          'Use zafu_frost_sign_orchard, which binds the signature to a PCZT the ' +
          'user can actually inspect.',
      });
      return true;
    }

    case 'zafu_frost_sign_orchard': {
      if (!ENABLE_FROST_SIGN_ORCHARD) {
        sendResponse({
          error:
            'zafu_frost_sign_orchard is disabled in this build (display↔sighash binding pending)',
        });
        return true;
      }
      void (async () => {
        const gate = await requireCapability(sender, 'frost', sendResponse);
        if (!gate) {
          return;
        }
        const roomCode = String(msg['roomCode'] || '');
        if (!roomCode) {
          sendResponse({ error: 'roomCode required' });
          return;
        }
        const plan = msg['plan'] as { address: string; amount_zat: number }[] | undefined;
        if (!plan || !Array.isArray(plan) || plan.length === 0) {
          sendResponse({ error: 'plan array required' });
          return;
        }
        const relayUrl = String(msg['relayUrl'] || DEFAULT_RELAY_URL);
        const feeZat = Number(msg['feeZat']) || 10_000;
        // Empty is allowed here because the popup falls back to the default
        // multisigVault; the popup looks up via startsWith - same charset rules.
        const rawLabel = typeof msg['multisigLabel'] === 'string' ? msg['multisigLabel'] : '';
        const multisigLabel = rawLabel.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
        const requestId = crypto.randomUUID();

        const params = new URLSearchParams({
          app: gate.origin,
          action: 'poker-sign',
          roomCode,
          relayUrl,
          feeZat: String(feeZat),
          planJson: JSON.stringify(plan),
          requestId,
        });
        if (multisigLabel) {
          params.set('multisigLabel', multisigLabel);
        }
        const url = chrome.runtime.getURL(`popup.html#/frost-approve?${params.toString()}`);
        pendingPicks.set(requestId, sendResponse);
        if (!(await openApprovalPopup(gate.origin, url, requestId))) {
          pendingPicks.delete(requestId);
          sendResponse({ error: 'denied' });
          return;
        }
      })();
      return true;
    }

    case 'zafu_delete_multisig': {
      void (async () => {
        const gate = await requireCapability(sender, 'frost', sendResponse);
        if (!gate) {
          return;
        }
        // Sanitize charset + cap length, and require a minimum so a label
        // prefix can't be enumerated. Origin-binding in findVaultByLabelPrefix
        // is the real guard; this is defense in depth. All rejections are the
        // uniform 'denied' shape (and only after the capability gate) so a
        // caller can't distinguish rejection causes - same contract as
        // requireCapability.
        const rawLabel = typeof msg['multisigLabel'] === 'string' ? msg['multisigLabel'] : '';
        const multisigLabel = rawLabel.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
        const MIN_DELETE_LABEL_LEN = 4;
        if (multisigLabel.length < MIN_DELETE_LABEL_LEN) {
          sendResponse({ success: false, error: 'denied' });
          return;
        }
        try {
          const { findVaultByLabelPrefix, cancelScheduledDelete } =
            await import('../../state/keyring/scheduled-deletes');
          // origin-scoped lookup - refuses cross-origin label collisions.
          const vaultId = await findVaultByLabelPrefix(multisigLabel, gate.origin);
          if (!vaultId) {
            sendResponse({ success: false, error: 'denied' });
            return;
          }
          // POLICY (money-safety): a dapp can no longer DESTROY a multisig share. A FROST key is
          // not seed-recoverable and has no auto-backup, and a "settled" table may still receive a
          // late deposit or hold a not-yet-credited balance - so we RETAIN it (it's already hidden
          // from the UI) rather than purge. Any prior schedule is cancelled. Removal is exclusively
          // a user-initiated, balance+sync-gated action in the wallet's multisig manager.
          await cancelScheduledDelete(vaultId);
          sendResponse({ success: true, retained: true, vaultId });
        } catch {
          sendResponse({ success: false, error: 'denied' });
        }
      })();
      return true;
    }

    case 'zafu_frost_result': {
      // internal: frost approval popup sends result back
      const requestId = String(msg['requestId'] || '');
      const callback = pendingPicks.get(requestId);
      if (callback) {
        callback(msg['result'] || { error: 'no result' });
        pendingPicks.delete(requestId);
      }
      sendResponse({ ok: true });
      return true;
    }

    case 'zafu_request_capability': {
      const capability = msg['capability'] as string;
      if (!capability || !(capability in CAPABILITY_META)) {
        sendResponse({ error: 'invalid capability' });
        return true;
      }
      const cap = capability as Capability;
      const origin = sender.origin || sender.url;
      if (!origin) {
        sendResponse({ error: 'unknown origin' });
        return true;
      }

      void (async () => {
        try {
          const perms = await getOriginPermissions(origin);
          const grantedToOrigin = hasCapability(perms, cap);

          // One pure decision over both questions: does zafu offer this
          // capability at all (global mode), and may this site use it? An
          // undecided capability prompts the one-time global question first,
          // and the decision is then re-made with the answer persisted - so the
          // per-site prompt below only ever runs for a feature the user wants.
          let decision = decideCapabilityUse({
            mode: await getCapabilityMode(cap),
            grantedToOrigin,
          });
          if (decision.action === 'prompt' && decision.prompt === 'opt-in') {
            const optin = await askOptin(origin, cap);
            if (optin.cancelled) {
              // the user never answered: report no decision, not a denial.
              sendResponse({ granted: false, capability: cap });
              return;
            }
            const answeredMode = modeFromOptin(optin.approved);
            await setCapabilityMode(cap, answeredMode);
            decision = decideCapabilityUse({ mode: answeredMode, grantedToOrigin });
          }
          if (decision.action === 'allow') {
            sendResponse({ granted: true, capability: cap });
            return;
          }
          if (decision.action === 'refuse') {
            sendResponse({ granted: false, denied: true, capability: cap });
            return;
          }

          // previously denied
          if (isDenied(perms, cap)) {
            sendResponse({ granted: false, denied: true, capability: cap });
            return;
          }

          // open approval popup for this capability (shared with
          // zafu_passkey_get's re-authorization-after-expiry path)
          const outcome = await requestCapabilityApprovalPopup(origin, cap, sender);
          if (outcome === 'approved') {
            sendResponse({ granted: true, capability: cap });
          } else if (outcome === 'cancelled') {
            sendResponse({ granted: false, capability: cap });
          } else {
            sendResponse({ granted: false, denied: true, capability: cap });
          }
        } catch {
          // getOriginPermissions / grant|denyCapability can throw on storage
          // failure; respond so the message channel doesn't hang.
          sendResponse({ error: 'internal error' });
        }
      })();

      return true;
    }

    case 'zafu_capability_result': {
      // internal: capability approval popup sends result back
      const requestId = String(msg['requestId'] || '');
      const callback = pendingPicks.get(requestId);
      if (callback) {
        callback(msg['result'] || { approved: false });
        pendingPicks.delete(requestId);
      }
      // Release the origin guard NOW, not on the eventual window-close event
      // - see releasePopupGuardForRequest. This is the screen askOptin and
      // requestCapabilityApprovalPopup both use, so it is what lets a
      // same-origin global-then-per-site consent pair run back to back.
      releasePopupGuardForRequest(requestId);
      sendResponse({ ok: true });
      return true;
    }

    // ── Open the wallet's own shield-in screen (dapp handoff) ──

    case 'zafu_open_shield': {
      // A dapp (e.g. Veil's deposit flow) asks the wallet to show ITS shield
      // screen. Nothing crosses back: no address, key, amount or destination.
      // The wallet picks the surface and runs the shield flow itself.
      if (!isValidExternalSender(sender)) {
        sendResponse({ error: 'denied', code: 'denied' });
        return true;
      }
      const shieldChain = String(msg['chainId'] ?? '');
      if (!OPEN_SHIELD_CHAINS.has(shieldChain)) {
        sendResponse({ error: `unsupported chainId '${shieldChain}'`, code: 'invalid_request' });
        return true;
      }
      const shieldOrigin = sender.origin;
      void (async () => {
        try {
          const shieldMode = await ensureCapabilityMode('connect', shieldOrigin);
          if (!shieldMode.ok) {
            sendResponse({
              error: shieldMode.reason === 'cancelled' ? 'cancelled' : 'not connected',
              code: 'denied',
            });
            return;
          }
          const perms = await getOriginPermissions(shieldOrigin);
          if (!hasCapability(perms, 'connect')) {
            sendResponse({ error: 'not connected', code: 'denied' });
            return;
          }
          if (!(await openWalletRoute(shieldOrigin, `${PopupPath.RECEIVE}?mode=shield`))) {
            sendResponse({ error: 'a wallet window is already open', code: 'rate_limited' });
            return;
          }
          sendResponse({ opened: true });
        } catch (e) {
          sendResponse({
            error: e instanceof Error ? e.message : 'internal error',
            code: 'internal_error',
          });
        }
      })();
      return true;
    }

    // ── Fresh cosmos burner address (unshield receiver rotation) ──

    case 'zafu_get_fresh_chain_address': {
      // Headless provider method: derives a fresh inj1…/osmo1… burner address
      // per unshield so an on-chain observer cannot group exits by receiver.
      // Only relevant for the unshield direction (shielded -> transparent);
      // deposits use a stable address for CEX compliance.
      //
      // Gates (in order):
      //   1. valid external sender (rejects iframes and unauthenticated pages)
      //   2. requested chain is a known CosmosChainId
      //   3. origin holds the 'connect' capability - first call prompts the
      //      user like any other connect; subsequent calls succeed silently
      //   4. per-origin+chain rate limit (100 / 24 h) - a hostile site can't
      //      pump the counter into the millions and bomb the user's UX
      //   5. wallet is unlocked and has a mnemonic vault selected
      //
      // TODO(later): per-address approval popup. Not built here because the
      // whole point of this API is one-click unshield UX; a popup per
      // derivation would defeat that. A dedicated confirmation lives in the
      // unshield flow instead.
      if (!isValidExternalSender(sender)) {
        sendResponse({ error: 'denied', code: 'denied' });
        return true;
      }
      const freshOrigin = sender.origin;
      const rawChainId = String(msg['chainId'] ?? '');
      if (!rawChainId || !(rawChainId in COSMOS_CHAINS)) {
        sendResponse({ error: `unknown chainId '${rawChainId}'`, code: 'invalid_request' });
        return true;
      }
      const chainId = rawChainId;

      void (async () => {
        try {
          const perms = await getOriginPermissions(freshOrigin);
          if (!hasCapability(perms, 'connect')) {
            sendResponse({ error: 'not connected', code: 'denied' });
            return;
          }

          const gate = await checkAndBumpFreshAddressRateLimit(freshOrigin, chainId);
          if (!gate.ok) {
            sendResponse({
              error: `rate limit exceeded; retry in ${Math.ceil(gate.retryAfterMs / 1000)}s`,
              code: 'rate_limited',
            });
            return;
          }

          // Wallet state: needs to be unlocked and have a selected mnemonic
          // vault. Any failure between here and derivation is opaque
          // ('internal_error') so we don't leak "locked" vs "no vault".
          const { useStore } = await import('../../state');
          const keyInfo = useStore.getState().keyRing.selectedKeyInfo;
          if (!keyInfo) {
            sendResponse({ error: 'wallet locked', code: 'locked' });
            return;
          }
          let mnemonic: string;
          try {
            mnemonic = await useStore.getState().keyRing.getMnemonic(keyInfo.id);
          } catch {
            sendResponse({ error: 'wallet locked', code: 'locked' });
            return;
          }

          try {
            const hdIndex = await nextHdIndex(chainId);
            const { deriveFreshChainAddress } =
              await import('@repo/wallet/networks/cosmos/fresh-address');
            const derived = await deriveFreshChainAddress(chainId, mnemonic, hdIndex);
            // remembered as shown, so the wallet keeps watching it even after
            // it falls out of the recent-index window
            const { rememberShownIndex } = await import('../../transparent/hd');
            await rememberShownIndex(chainId, keyInfo.id, hdIndex).catch(() => undefined);
            sendResponse({ address: derived.address, hdIndex: derived.hdIndex });
          } finally {
            // Best-effort scrub of the mnemonic reference. JS strings are
            // immutable so this only drops the local binding; GC still governs
            // when the underlying storage is reclaimed.
            mnemonic = '';
          }
        } catch (e) {
          sendResponse({
            error: e instanceof Error ? e.message : 'internal error',
            code: 'internal_error',
          });
        }
      })();
      return true;
    }

    // ── Zcash transaction (multi-output, for poker escrow) ──

    case 'zafu_zcash_send': {
      // Multi-output Zcash Orchard transaction
      // Used by poker.zk.bot for: rake + escrow deposit in one tx
      //
      // msg.outputs: [{address: string, amount: number, memo?: string}]
      // msg.fee?: number (default 10000 = 0.0001 ZEC)
      //
      // Opens approval popup showing all outputs for user confirmation
      const outputs = msg['outputs'] as { address: string; amount: number; memo?: string }[];
      if (!outputs || !Array.isArray(outputs) || outputs.length === 0) {
        sendResponse({ success: false, error: 'outputs array required' });
        return true;
      }

      const totalAmount = outputs.reduce((sum, o) => sum + (o.amount || 0), 0);
      const fee = Number(msg['fee']) || 10_000;
      // the guard above already required a valid top-frame https sender
      const appOrigin = sender.origin ?? 'unknown';
      const requestId = crypto.randomUUID();

      pendingPicks.set(requestId, sendResponse);

      const params = new URLSearchParams({
        app: appOrigin,
        requestId,
        total: String(totalAmount),
        fee: String(fee),
        numOutputs: String(outputs.length),
        outputsJson: JSON.stringify(outputs),
      });
      const url = chrome.runtime.getURL(`popup.html#/approval/zcash-send?${params.toString()}`);
      // Same per-origin dedup as every other high-risk popup: a second
      // concurrent send from the same origin is dropped instead of stacking
      // another window.
      void (async () => {
        if (!(await openApprovalPopup(appOrigin, url, requestId))) {
          if (pendingPicks.delete(requestId)) {
            sendResponse({ success: false, error: 'denied' });
          }
        }
      })();
      return true;
    }

    case 'zafu_zcash_send_result': {
      // Internal: Zcash send approval popup returns result
      const requestId = String(msg['requestId'] || '');
      const callback = pendingPicks.get(requestId);
      if (callback) {
        callback(msg['result'] || { success: false, error: 'no result' });
        pendingPicks.delete(requestId);
      }
      sendResponse({ ok: true });
      return true;
    }

    // note: zafu_zcash_build_and_send was removed - the approval popup now builds
    // and broadcasts transactions directly via the zcash worker (buildMultiSendTxInWorker).
    // The popup sends the result back through zafu_zcash_send_result.

    // ── passkey / WebAuthn ──
    // Every create and every sign-in takes one tap in zafu. The `passkey`
    // grant only means "this site may ask"; it never signs on its own.

    case 'zafu_passkey_create': {
      const {
        rpId,
        userId: userIdHex,
        excludeCredentials,
      } = msg as {
        rpId: string;
        userId?: string;
        excludeCredentials?: unknown;
      };
      // origin is the browser-attested sender, never a caller-supplied field
      if (!passkeySender(sender)) {
        sendResponse({ success: false, error: 'not connected' });
        return true;
      }
      const origin = sender.origin;
      void (async () => {
        try {
          // the full suffix list loads only when a site asks for a passkey
          const { rpIdMatchesOrigin } = await import('../../state/public-suffix');
          if (!rpIdMatchesOrigin(rpId, origin)) {
            sendResponse({ success: false, error: 'rpId does not match origin' });
            return;
          }
          const ready = await passkeyReady(origin);
          if (!ready.ok) {
            sendResponse(ready.refusal);
            return;
          }
          const { useStore } = await import('../../state');
          const wallet = useStore.getState().keyRing.selectedKeyInfo;
          if (wallet?.type !== 'mnemonic') {
            sendResponse({ success: false, error: 'no wallet selected', code: 'no-wallet' });
            return;
          }
          // WebAuthn caps a user handle at 64 bytes
          const userId = hexToBytes(userIdHex ?? '');
          if (userId.length > 64) {
            sendResponse({ success: false, error: 'user id too long' });
            return;
          }
          const outcome = await askPasskeyTap('create', origin, rpId, wallet.id);
          if (outcome !== 'approved') {
            sendResponse(declined(outcome));
            return;
          }
          try {
            const { createCredential, findCredential } = await import('../../state/webauthn');
            const { getIdentityKey } = await import('../../state/identity-keys');
            const identity = await getIdentityKey(
              wallet.id,
              useStore.getState().keyRing.getMnemonic,
            );
            // the site already holds one of this wallet's passkeys: answered
            // only after the tap, so a page cannot probe for it silently
            if (await findCredential(identity, rpId, credentialIds(excludeCredentials))) {
              identity.fill(0);
              sendResponse({ success: false, error: 'exists', code: 'exists' });
              return;
            }
            const result = await createCredential(identity, rpId, userId, ready.verified);
            identity.fill(0);
            await grantPasskey(origin, rpId, wallet, userId);
            sendResponse({
              success: true,
              credentialId: bytesToHex(result.credentialId),
              authenticatorData: bytesToHex(result.authenticatorData),
              publicKey: bytesToHex(result.publicKey),
              prfEnabled: true,
            });
          } catch {
            // `failed`: the person already said yes, so this is zafu's own
            // failure; the page reports it rather than falling back to the
            // platform authenticator
            sendResponse({ success: false, code: 'failed' });
          }
        } catch {
          sendResponse({ success: false, error: 'denied' });
        }
      })();
      return true;
    }

    case 'zafu_passkey_result': {
      // internal: the passkey screen reports the tap; the worker does the rest
      const requestId = String(msg['requestId'] || '');
      takePendingApproval(requestId)?.(msg['result'] || { approved: false });
      releasePopupGuardForRequest(requestId);
      sendResponse({ ok: true });
      return true;
    }

    case 'zafu_passkey_get': {
      const {
        rpId,
        challenge: challengeHex,
        clientDataHash: clientDataHashHex,
        prfSalts,
        allowCredentials,
      } = msg as {
        rpId: string;
        challenge?: string;
        clientDataHash: string;
        prfSalts?: { first: string; second?: string };
        allowCredentials?: unknown;
      };
      // origin is the browser-attested sender, never a caller-supplied field -
      // otherwise any site could forge assertions for an arbitrary rpId
      if (!passkeySender(sender)) {
        sendResponse({ success: false, error: 'not connected' });
        return true;
      }
      const origin = sender.origin;
      void (async () => {
        try {
          // the full suffix list loads only when a site asks for a passkey
          const { rpIdMatchesOrigin } = await import('../../state/public-suffix');
          if (!rpIdMatchesOrigin(rpId, origin)) {
            sendResponse({ success: false, error: 'rpId does not match origin' });
            return;
          }
          // The page builds the client data the relying party will check, so
          // rebuild it here from the challenge and the browser-attested origin
          // and sign only that: a page cannot get a signature over client data
          // naming another origin, or over a hash it chose.
          let clientDataMatches = false;
          try {
            clientDataMatches =
              typeof challengeHex === 'string' &&
              typeof clientDataHashHex === 'string' &&
              bytesToHex(
                sha256(clientDataJson('webauthn.get', hexToBytes(challengeHex), origin)),
              ) === clientDataHashHex.toLowerCase();
          } catch {
            clientDataMatches = false;
          }
          if (!clientDataMatches) {
            sendResponse({ success: false, error: 'client data does not match the request' });
            return;
          }
          // `passkey`, or `connect` for a passkey made before `passkey`
          // existed, lets the site ask; nothing else may even raise the tap
          const granted = (await getOriginPermissions(origin))?.granted ?? [];
          if (!granted.includes('passkey') && !granted.includes('connect')) {
            sendResponse({ success: false, error: 'not connected' });
            return;
          }
          const ready = await passkeyReady(origin);
          if (!ready.ok) {
            sendResponse(ready.refusal);
            return;
          }
          const { signAssertion, findCredential, discoverableCredential } =
            await import('../../state/webauthn');
          const { getIdentityKey } = await import('../../state/identity-keys');
          const { useStore } = await import('../../state');
          const { pocketOwner } = await import('../../state/pockets');
          const keyRing = useStore.getState().keyRing;
          // only a wallet that made a passkey for this rpId from this origin
          // may answer, newest first; an origin with no recorded grant made
          // its passkey before grants were recorded, with the wallet selected
          // then and one passkey per rpId
          const here = grantsFor(await readPasskeyGrants(), origin, rpId);
          const asked = (here ?? [{ owner: undefined, userId: undefined }]).map(g => ({
            wallet:
              g.owner === undefined
                ? keyRing.selectedKeyInfo
                : keyRing.keyInfos.find(k => pocketOwner(k) === g.owner),
            userId: g.userId,
          }));
          // the relying party lists the credentials it knows; when none is
          // this wallet's the request belongs to another authenticator
          const allowIds = credentialIds(allowCredentials);
          let found: { wallet: KeyInfo; identity: Uint8Array; credential: Credential } | undefined;
          for (const { wallet, userId } of asked) {
            if (wallet?.type !== 'mnemonic') {
              continue;
            }
            const identity = await getIdentityKey(wallet.id, keyRing.getMnemonic);
            const credential = allowIds.length
              ? await findCredential(identity, rpId, allowIds)
              : await discoverableCredential(
                  identity,
                  rpId,
                  userId ? hexToBytes(userId) : undefined,
                );
            if (credential) {
              found = { wallet, identity, credential };
              break;
            }
            identity.fill(0);
          }
          if (!found) {
            sendResponse({ success: false, error: 'no zafu credential for this request' });
            return;
          }
          const outcome = await askPasskeyTap('get', origin, rpId, found.wallet.id);
          if (outcome !== 'approved') {
            found.identity.fill(0);
            sendResponse(declined(outcome));
            return;
          }
          // the tap is the user presence the assertion claims
          const { credential } = found;
          const result = signAssertion(
            found.identity,
            rpId,
            credential,
            hexToBytes(clientDataHashHex),
            prfSalts,
            ready.verified,
          );
          found.identity.fill(0);
          await grantPasskey(origin, rpId, found.wallet, credential.userId);
          sendResponse({
            success: true,
            credentialId: bytesToHex(credential.id),
            userHandle: credential.userId ? bytesToHex(credential.userId) : undefined,
            authenticatorData: bytesToHex(result.authenticatorData),
            signature: bytesToHex(result.signature),
            prfResults: result.prfResults
              ? {
                  first: bytesToHex(result.prfResults.first),
                  second: result.prfResults.second
                    ? bytesToHex(result.prfResults.second)
                    : undefined,
                }
              : undefined,
          });
        } catch {
          // `failed`: zafu holds this credential, so a signing error must be
          // reported rather than rerouted to the platform authenticator
          sendResponse({ success: false, code: 'failed' });
        }
      })();
      return true;
    }

    default: {
      // don't respond to types handled by other listeners
      const delegatedTypes = [
        'zafu_sign', // handled by sign-request.ts
        'zafu_encrypt',
        'zafu_decrypt',
        'zafu_zid_pubkey',
        'zafu_encryption_approval_result', // handled by external-encryption.ts
        'zafu_request_contact_discovery', // handled by contact-discovery-request.ts
        // handled by contact-discovery.ts: answering here first left every
        // site with "unknown message type", so discovery never ran
        'zafu_discover_contacts',
      ];
      if (typeof type === 'string' && delegatedTypes.includes(type)) {
        return false;
      }
      sendResponse({ error: 'unknown message type' });
      return true;
    }
  }
};
