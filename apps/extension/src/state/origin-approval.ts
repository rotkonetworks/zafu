import { UserChoice } from '@repo/storage-chrome/records';
import { Capability } from '@repo/storage-chrome/capabilities';
import { AllSlices, SliceCreator } from '.';
import { PopupRequest, PopupResponse, PopupType } from '../message/popup';
import type { ChainInUse } from '../penumbra/chain';

export interface OriginApprovalSlice {
  responder?: PromiseWithResolvers<
    PopupResponse<PopupType.OriginApproval>[PopupType.OriginApproval]
  >;
  favIconUrl?: string;
  title?: string;
  requestOrigin?: string;
  choice?: UserChoice;
  lastRequest?: Date;
  /** Capabilities being requested in this approval */
  requestedCapabilities: Capability[];
  /** the penumbra chain the approval binds to; unset until a request names it */
  chain?: ChainInUse;

  acceptRequest: (
    req: PopupRequest<PopupType.OriginApproval>[PopupType.OriginApproval],
  ) => Promise<PopupResponse<PopupType.OriginApproval>[PopupType.OriginApproval]>;

  setChoice: (attitute: UserChoice) => void;

  sendResponse: () => void;
}

export const createOriginApprovalSlice = (): SliceCreator<OriginApprovalSlice> => (set, get) => ({
  requestedCapabilities: ['connect'],

  setChoice: (choice: UserChoice) => {
    set(state => {
      state.originApproval.choice = choice;
    });
  },

  acceptRequest: req => {
    const { origin: requestOrigin, favIconUrl, title, lastRequest, chain } = req;

    const existing = get().originApproval;
    if (existing.responder) {
      throw new Error('Another request is still pending');
    }

    // set responder synchronously
    const responder =
      Promise.withResolvers<PopupResponse<PopupType.OriginApproval>[PopupType.OriginApproval]>();
    set(state => {
      state.originApproval.responder = responder;
    });

    // extract requested capabilities from the request if present
    const capabilities: Capability[] =
      'capabilities' in req && Array.isArray((req as Record<string, unknown>)['capabilities'])
        ? ((req as Record<string, unknown>)['capabilities'] as Capability[])
        : ['connect'];

    set(state => {
      state.originApproval.favIconUrl = favIconUrl;
      state.originApproval.title = title && !title.startsWith(requestOrigin) ? title : undefined;
      state.originApproval.requestOrigin = requestOrigin;
      state.originApproval.lastRequest = lastRequest ? new Date(lastRequest) : undefined;
      state.originApproval.requestedCapabilities = capabilities;
      state.originApproval.chain = chain;
    });

    return responder.promise;
  },

  sendResponse: () => {
    const { responder, choice, requestOrigin } = get().originApproval;

    try {
      if (!responder) {
        throw new Error('No responder');
      }
      try {
        if (choice === undefined || !requestOrigin) {
          throw new ReferenceError('Missing response data');
        }

        responder.resolve({
          choice,
          origin: requestOrigin,
          date: Date.now(),
        });
      } catch (e) {
        responder.reject(e);
      }
    } finally {
      set(state => {
        state.originApproval.responder = undefined;
        state.originApproval.choice = undefined;
        state.originApproval.requestOrigin = undefined;
        state.originApproval.favIconUrl = undefined;
        state.originApproval.title = undefined;
        state.originApproval.requestedCapabilities = ['connect'];
        state.originApproval.chain = undefined;
      });
    }
  },
});

export const originApprovalSelector = (state: AllSlices) => state.originApproval;
