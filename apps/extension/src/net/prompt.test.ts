/**
 * The destination consent prompt: the one window that turns an unknown host
 * into a decision, and the callback that carries the answer back.
 *
 * The prompt's window plumbing is mocked (no `chrome.windows` in this
 * environment), but everything the prompt itself decides is exercised for real:
 * the answer -> ledger mapping, the cancelled-window semantics, and the sender
 * check on the result listener - a page that guessed a requestId must never be
 * able to self-deliver a consent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const pending = new Map<string, (r: unknown) => void>();
  return {
    pending,
    setDecision: vi.fn(async () => undefined),
    openApprovalPopup: vi.fn(async () => true),
  };
});

vi.mock('../message/listen/external-easteregg', () => ({
  openApprovalPopup: h.openApprovalPopup,
  registerPendingApproval: (requestId: string, cb: (r: unknown) => void) =>
    h.pending.set(requestId, cb),
  takePendingApproval: (requestId: string) => {
    const cb = h.pending.get(requestId);
    h.pending.delete(requestId);
    return cb;
  },
}));

vi.mock('./ledger', () => ({ setDestinationDecision: h.setDecision }));

import { NET_PURPOSE_LABEL } from './purpose';
import { requestDestinationConsent, destinationConsentResultListener } from './prompt';

const HOST = 'rpc.unknown.example';

// jsdom has no chrome.runtime.getURL; the prompt builds the window URL with it.
(chrome.runtime as { getURL?: (path: string) => string }).getURL = (path: string) =>
  `chrome-extension://${chrome.runtime.id}/${path.replace(/^\//, '')}`;

beforeEach(() => {
  h.pending.clear();
  h.setDecision.mockClear();
  h.openApprovalPopup.mockClear();
  h.openApprovalPopup.mockResolvedValue(true);
});

/** Start a prompt and hand back its in-flight promise plus the registered reply. */
const startPrompt = async (context: Parameters<typeof requestDestinationConsent>[2] = {}) => {
  const decision = requestDestinationConsent(HOST, 'chain-rpc', context);
  const [requestId, reply] = [...h.pending.entries()][0] ?? [];
  expect(requestId).toBeDefined();
  await Promise.resolve(); // let the window-open await settle
  return { decision, requestId: requestId as string, reply: reply as (r: unknown) => void };
};

describe('requestDestinationConsent', () => {
  it('records an approval as an allowed host', async () => {
    const { decision, reply } = await startPrompt();
    reply({ approved: true });
    expect(await decision).toBe('approved');
    expect(h.setDecision).toHaveBeenCalledWith(HOST, 'allowed');
  });

  it('records a denial as a blocked host', async () => {
    const { decision, reply } = await startPrompt();
    reply({ approved: false });
    expect(await decision).toBe('denied');
    expect(h.setDecision).toHaveBeenCalledWith(HOST, 'blocked');
  });

  it('a window closed without an answer is not recorded as a denial', async () => {
    // The user never said no; the host goes back to undecided so the question
    // can be asked again, and the request that raised it is refused now.
    const { decision, reply } = await startPrompt();
    reply({ cancelled: true });
    expect(await decision).toBe('cancelled');
    expect(h.setDecision).toHaveBeenCalledWith(HOST, 'pending');
  });

  it('a window that never opened resolves cancelled instead of hanging', async () => {
    h.openApprovalPopup.mockResolvedValueOnce(false);
    const { decision } = await startPrompt();
    expect(await decision).toBe('cancelled');
    expect(h.setDecision).toHaveBeenCalledWith(HOST, 'pending');
  });

  it('names the host, the purpose and the asking app in the window URL', async () => {
    const { decision, reply } = await startPrompt({
      origin: 'https://dapp.example',
      detail: 'to sync',
    });
    const url = h.openApprovalPopup.mock.calls[0][1];
    expect(url).toContain('#/approval/destination?');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('host')).toBe(HOST);
    expect(params.get('purpose')).toBe('chain-rpc');
    expect(params.get('purposeLabel')).toBe(NET_PURPOSE_LABEL['chain-rpc']);
    expect(params.get('app')).toBe('https://dapp.example');
    expect(params.get('detail')).toBe('to sync');
    expect(params.get('requestId')).toBeTruthy();
    reply({ approved: false });
    await decision;
  });

  it('omits the app and detail params when nothing asked for the request', async () => {
    const { decision, reply } = await startPrompt();
    const params = new URLSearchParams(h.openApprovalPopup.mock.calls[0][1].split('?')[1]);
    expect(params.has('app')).toBe(false);
    expect(params.has('detail')).toBe(false);
    reply({ approved: false });
    await decision;
  });
});

describe('destinationConsentResultListener', () => {
  const sender = (id: string) => ({ id }) as chrome.runtime.MessageSender;
  const sendResponse = () => vi.fn();

  it('settles the pending prompt from the wallet itself', async () => {
    const { decision, requestId } = await startPrompt();
    const respond = sendResponse();
    const claimed = destinationConsentResultListener(
      { type: 'zafu_destination_approval_result', requestId, result: { approved: true } },
      sender(chrome.runtime.id),
      respond,
    );
    expect(claimed).toBe(true);
    expect(await decision).toBe('approved');
    expect(respond).toHaveBeenCalled();
  });

  it('ignores an answer from a page that guessed the requestId', async () => {
    const { decision, requestId } = await startPrompt();
    const respond = sendResponse();
    const claimed = destinationConsentResultListener(
      { type: 'zafu_destination_approval_result', requestId, result: { approved: true } },
      sender('a-page-origin'),
      respond,
    );
    expect(claimed).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    // still unanswered, so it resolves cancelled when the window closes
    const [, reply] = [...h.pending.entries()][0];
    reply({ cancelled: true });
    expect(await decision).toBe('cancelled');
    expect(h.setDecision).toHaveBeenCalledWith(HOST, 'pending');
  });

  it('ignores unrelated messages', () => {
    const respond = sendResponse();
    expect(
      destinationConsentResultListener(
        { type: 'zafu_pick_contacts' },
        sender(chrome.runtime.id),
        respond,
      ),
    ).toBe(false);
    expect(
      destinationConsentResultListener('nonsense' as unknown, sender(chrome.runtime.id), respond),
    ).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });

  it('sends nothing for an unknown requestId', () => {
    const respond = sendResponse();
    const claimed = destinationConsentResultListener(
      { type: 'zafu_destination_approval_result', requestId: 'gone', result: { approved: true } },
      sender(chrome.runtime.id),
      respond,
    );
    expect(claimed).toBe(true);
    expect(respond).toHaveBeenCalledWith({ ok: true });
  });
});
