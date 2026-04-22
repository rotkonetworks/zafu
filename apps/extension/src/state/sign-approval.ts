import { UserChoice } from '@repo/storage-chrome/records';
import { AllSlices, SliceCreator } from '.';
import { PopupRequest, PopupResponse, PopupType } from '../message/popup';

export interface SignApprovalSlice {
  responder?: PromiseWithResolvers<
    PopupResponse<PopupType.SignRequest>[PopupType.SignRequest]
  >;
  origin?: string;
  favIconUrl?: string;
  title?: string;
  challengeHex?: string;
  statement?: string;
  algorithm?: 'ed25519' | 'es256'; // ed25519 = ZID default, es256 = WebAuthn/passkey compat
  isAirgap?: boolean;
  zidPubkey?: string;
  choice?: UserChoice;

  acceptRequest: (
    req: PopupRequest<PopupType.SignRequest>[PopupType.SignRequest],
  ) => Promise<PopupResponse<PopupType.SignRequest>[PopupType.SignRequest]>;

  setChoice: (choice: UserChoice) => void;

  sendResponse: (result?: { signature: string; publicKey: string }) => void;
}

export const createSignApprovalSlice = (): SliceCreator<SignApprovalSlice> => (set, get) => ({
  setChoice: (choice: UserChoice) => {
    set(state => {
      state.signApproval.choice = choice;
    });
  },

  acceptRequest: req => {
    const existing = get().signApproval;
    if (existing.responder) {
      throw new Error('Another sign request is still pending');
    }

    const responder =
      Promise.withResolvers<PopupResponse<PopupType.SignRequest>[PopupType.SignRequest]>();
    set(state => {
      state.signApproval.responder = responder;
      state.signApproval.origin = req.origin;
      state.signApproval.favIconUrl = req.favIconUrl;
      state.signApproval.title = req.title;
      state.signApproval.challengeHex = req.challengeHex;
      state.signApproval.statement = req.statement;
      state.signApproval.algorithm = req.algorithm ?? 'ed25519';
      state.signApproval.isAirgap = req.isAirgap;
      state.signApproval.zidPubkey = req.zidPubkey;
    });

    return responder.promise;
  },

  sendResponse: (result) => {
    const { responder, choice } = get().signApproval;

    try {
      if (!responder) {
        throw new Error('No responder');
      }
      try {
        if (choice === undefined) {
          throw new ReferenceError('Missing response data');
        }

        responder.resolve({
          choice,
          signature: result?.signature,
          publicKey: result?.publicKey,
        });
      } catch (e) {
        responder.reject(e);
      }
    } finally {
      set(state => {
        state.signApproval.responder = undefined;
        state.signApproval.choice = undefined;
        state.signApproval.origin = undefined;
        state.signApproval.favIconUrl = undefined;
        state.signApproval.title = undefined;
        state.signApproval.challengeHex = undefined;
        state.signApproval.statement = undefined;
        state.signApproval.algorithm = undefined;
        state.signApproval.isAirgap = undefined;
        state.signApproval.zidPubkey = undefined;
      });
    }
  },
});

export const signApprovalSelector = (state: AllSlices) => state.signApproval;
