import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Lets react-dom's act() run outside a test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every render hands back a NEW navigate function, like the real
// useTypesafeNav. That instability is what the regression test depends on.
const navigateCalls: string[] = [];
vi.mock('../utils/navigate', () => ({
  usePopupNav: () => (to: string) => navigateCalls.push(to),
}));
vi.mock('../utils/popup-detection', () => ({ isSidePanel: () => true }));
vi.mock('../senders/internal', () => ({ isValidInternalSender: () => true }));
vi.mock('../message/side-panel-delivery', () => ({
  isSidePanelDeliver: (m: { type?: string }) => m.type === 'deliver',
  isSidePanelNavigate: () => false,
}));
const detach = vi.fn();
const wire = vi.fn((_id: string) => detach);
vi.mock('./popup-ready', () => ({ wirePopupDelivery: (id: string) => wire(id) }));

import { useSidePanelDelivery } from './side-panel-delivery';

type Listener = (msg: unknown, sender: unknown, respond: (r: unknown) => void) => boolean;
const listeners = new Set<Listener>();

let rerender: () => void = () => undefined;
const Host = () => {
  const [, set] = useState(0);
  rerender = () => set(n => n + 1);
  useSidePanelDelivery();
  return null;
};

describe('useSidePanelDelivery', () => {
  let root: Root;

  beforeEach(() => {
    listeners.clear();
    navigateCalls.length = 0;
    wire.mockClear();
    detach.mockClear();
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: {
          addListener: (l: Listener) => listeners.add(l),
          removeListener: (l: Listener) => listeners.delete(l),
        },
      },
    });
    root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Host)));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  const deliver = (popupId: string) => {
    for (const l of [...listeners]) {
      l({ type: 'deliver', popupId, route: '/approval/tx' }, {}, () => undefined);
    }
  };

  it('keeps the wired request listener across re-renders', () => {
    act(() => deliver('p1'));
    expect(wire).toHaveBeenCalledTimes(1);
    expect(navigateCalls).toEqual(['/approval/tx']);

    // The navigate above re-renders the panel in the real app. That used to
    // run the effect cleanup and detach the listener the worker's request
    // was about to arrive on.
    act(() => rerender());
    act(() => rerender());
    expect(detach).not.toHaveBeenCalled();
    expect(listeners.size).toBe(1);
  });

  it('wires a popup id once even if the worker re-sends the delivery', () => {
    act(() => deliver('p1'));
    act(() => deliver('p1'));
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it('detaches on unmount', () => {
    act(() => deliver('p1'));
    act(() => root.unmount());
    expect(detach).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    // afterEach unmounts again; give it a fresh root so that is a no-op.
    root = createRoot(document.createElement('div'));
  });
});
