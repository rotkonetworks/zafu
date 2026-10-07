import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useApproveGuard } from './use-approve-guard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (v: DocumentVisibilityState) =>
  act(() => {
    visibility = v;
    document.dispatchEvent(new Event('visibilitychange'));
  });
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('useApproveGuard', () => {
  let root: Root;
  let ready: boolean | undefined;
  const mount = (seconds: number) => {
    const Probe = () => {
      ready = useApproveGuard(seconds);
      return null;
    };
    root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Probe)));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    // a side panel the person has not clicked into
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is ready after the guard without the window ever having focus', () => {
    mount(0.5);
    expect(ready).toBe(false);
    advance(499);
    expect(ready).toBe(false);
    advance(1);
    expect(ready).toBe(true);
  });

  it('does not restart on focus or blur', () => {
    mount(0.5);
    advance(300);
    act(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });
    advance(200);
    expect(ready).toBe(true);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(ready).toBe(true);
  });

  it('starts over when the screen is hidden and shown again', () => {
    mount(0.5);
    advance(500);
    expect(ready).toBe(true);
    setVisibility('hidden');
    expect(ready).toBe(false);
    advance(1000);
    expect(ready).toBe(false);
    setVisibility('visible');
    advance(499);
    expect(ready).toBe(false);
    advance(1);
    expect(ready).toBe(true);
  });

  it('waits only once the screen is first visible', () => {
    visibility = 'hidden';
    mount(0.5);
    advance(2000);
    expect(ready).toBe(false);
    setVisibility('visible');
    advance(500);
    expect(ready).toBe(true);
  });

  it('holds a deliberate wait in full and needs none for zero', () => {
    mount(3);
    advance(2999);
    expect(ready).toBe(false);
    advance(1);
    expect(ready).toBe(true);
    act(() => root.unmount());
    mount(0);
    expect(ready).toBe(true);
  });
});
