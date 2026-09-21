import { useEffect, useRef } from 'react';
import { PopupRequest, PopupResponse, PopupType, typeOfPopupRequest } from '../message/popup';
import { useStore } from '../state';
import { listenPopup } from '../message/listen-popup';

const handlePopup = async <T extends PopupType>(
  popupRequest: PopupRequest<T>,
): Promise<PopupResponse<T>> => {
  const popupType = typeOfPopupRequest(popupRequest);

  // get popup slice acceptRequest method
  const state = useStore.getState();
  const acceptRequest: {
    [k in PopupType]: (request: PopupRequest<k>[k]) => Promise<PopupResponse<k>[k]>;
  } = {
    [PopupType.TxApproval]: state.txApproval.acceptRequest,
    [PopupType.OriginApproval]: state.originApproval.acceptRequest,
    [PopupType.SignRequest]: state.signApproval.acceptRequest,
  };

  // handle via slice
  const popupResponse = {
    [popupType]: await acceptRequest[popupType](popupRequest[popupType]),
  } as PopupResponse<T>;

  return popupResponse;
};

/**
 * Attach the popup-request listener for `popupId`, then ping the worker ready.
 *
 * Order is load-bearing: the listener must be live BEFORE the ready ping, because
 * the worker sends the request the instant it sees the ping (worker-side
 * listenReady). Shared by both delivery paths - the URL-driven detached window
 * (usePopupReady) and the message-driven side panel (useSidePanelDelivery) - so
 * request/response handling is identical however the doc was reached. Returns a
 * detacher for the listener.
 */
export const wirePopupDelivery = (popupId: string): (() => void) => {
  const listener = listenPopup(popupId, handlePopup);
  chrome.runtime.onMessage.addListener(listener);
  void chrome.runtime.sendMessage(popupId);
  return () => chrome.runtime.onMessage.removeListener(listener);
};

/**
 * Announces component readiness to the extension worker, then listens for a
 * dialog initialization message.
 *
 * The initialization message responder is stored in the dialog's state slice
 * and eventually used by components to respond with the dialog result. This is
 * the DETACHED-WINDOW path: the id comes from the URL the window was opened at.
 * The side panel reaches the same wiring via useSidePanelDelivery instead.
 */
export const usePopupReady = () => {
  const sentReady = useRef(new Set());

  useEffect(() => {
    if (!sentReady.current.size) {
      const popupId = new URLSearchParams(window.location.search).get('id');
      if (popupId) {
        wirePopupDelivery(popupId);
        sentReady.current.add(popupId);
      }
    }
  }, [sentReady]);
};
