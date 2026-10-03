/**
 * Intent preloading, the Solid Router way: a route declares `preload(ctx)`
 * (route-modules.ts `screen(name, preload)`), and the earliest sign that a
 * person is going there - pointerdown, hover on a fine pointer, keyboard
 * focus - loads its chunk and warms its queries, so the screen renders from
 * cache when the click lands.
 *
 * Nav primitives only say where they go (`data-preload="<path>"`, a Row's
 * `preload` prop); one delegated listener on the popup layout turns intent
 * into {@link preloadTarget}. Nothing here runs from a timer, a load, the
 * service worker or a hidden document.
 */

import { useLayoutEffect, type FocusEvent, type PointerEvent } from 'react';
import { matchRoutes, type RouteObject } from 'react-router-dom';
import type { QueryClient } from '@tanstack/react-query';
import { useStore } from '../../state';
import { preloadScreen, type Preload, type PreloadHandle } from './route-modules';

let routes: RouteObject[] = [];
let client: QueryClient | undefined;

/** the router and the query cache the preloads run against (popup-root, once) */
export const installPreload = (next: { routes: RouteObject[]; client: QueryClient }): void => {
  routes = next.routes;
  client = next.client;
};

const extra = new Map<string, Set<Preload>>();

/**
 * Add a preload to a route (its path pattern, e.g. `PopupPath.SWAP`) or to a
 * non-route target such as a sheet (`sheet:wallets`). Runs after the route's
 * own. Returns the unregister.
 */
export const registerRoutePreload = (target: string, preload: Preload): (() => void) => {
  const set = extra.get(target) ?? new Set();
  extra.set(target, set.add(preload));
  return () => void set.delete(preload);
};

/** a target fires at most once in this window; a cached preload is cheap anyway */
const WINDOW_MS = 3000;
const recent = new Map<string, number>();

const run = (preload: Preload | undefined, ctx: Parameters<Preload>[0]): void => {
  if (!preload) {
    return;
  }
  try {
    void Promise.resolve(preload(ctx)).catch(() => undefined);
  } catch {
    /* a preload never breaks the press it rides on */
  }
};

/** load a target's chunk and warm its data, once per window, only while zafu is in view */
export const preloadTarget = (to: string): void => {
  if (!client || typeof document === 'undefined' || document.visibilityState !== 'visible') {
    return;
  }
  const now = performance.now();
  if (now - (recent.get(to) ?? -Infinity) < WINDOW_MS) {
    return;
  }
  recent.set(to, now);

  const [pathname = '', query = ''] = to.split('?');
  const base = { client, state: useStore.getState(), search: new URLSearchParams(query) };
  const matches = to.startsWith('/') ? (matchRoutes(routes, pathname) ?? []) : [];
  for (const { route, params } of matches) {
    const handle = route.handle as PreloadHandle | undefined;
    if (handle?.screen) {
      preloadScreen(handle.screen);
    }
    run(handle?.preload, { ...base, params });
  }
  const key = matches.at(-1)?.route.path ?? to;
  for (const preload of extra.get(key) ?? []) {
    run(preload, { ...base, params: matches.at(-1)?.params ?? {} });
  }
};

// ── intent ──

const canHover =
  typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;

const targetOf = (e: { target: EventTarget | null }): string | undefined =>
  (e.target instanceof Element &&
    e.target.closest('[data-preload]')?.getAttribute('data-preload')) ||
  undefined;

/** pointerdown and keyboard focus are intent everywhere; hover only where hovering is a thing */
export const intentHandlers = {
  onPointerDownCapture: (e: PointerEvent) => {
    const to = targetOf(e);
    if (to) {
      markIntent(to);
      preloadTarget(to);
    }
  },
  onPointerOverCapture: (e: PointerEvent) => {
    const to = canHover && e.pointerType === 'mouse' ? targetOf(e) : undefined;
    if (to) {
      preloadTarget(to);
    }
  },
  onFocusCapture: (e: FocusEvent) => {
    const to = targetOf(e);
    if (to) {
      preloadTarget(to);
    }
  },
};

// ── [nav-timing]: intent (pointerdown) to the target's first paint ──

const readFlag = (): boolean => {
  try {
    return localStorage.getItem('zafu:nav-timing') === '1';
  } catch {
    return false;
  }
};

/**
 * Development builds (`pnpm dev`, webpack mode development), or a measuring
 * session that sets `localStorage['zafu:nav-timing'] = '1'`. Off in prod and
 * beta builds (mode production folds this to the flag alone).
 */
export const navTimingOn: boolean =
  (process.env as { NODE_ENV?: string }).NODE_ENV === 'development' || readFlag();

let pending: { to: string; from: string; t: number } | undefined;

const markIntent = (to: string): void => {
  if (navTimingOn) {
    pending = {
      to: to.split('?')[0] ?? to,
      from: location.hash.slice(1) || '/',
      t: performance.now(),
    };
  }
};

/** a press that never became this navigation (a hover-and-leave, a cancelled tap) goes stale */
const STALE_MS = 5000;

/**
 * As a screen (or sheet) commits: log the time from the press that asked for
 * it to the next frame, which is the first paint of what it shows.
 */
const reportPaint = (target: string): void => {
  const p = pending;
  if (!p || p.to !== target) {
    return;
  }
  pending = undefined;
  if (performance.now() - p.t > STALE_MS) {
    return;
  }
  requestAnimationFrame(() =>
    console.info(`[nav-timing] ${p.from} -> ${target} ${Math.round(performance.now() - p.t)}ms`),
  );
};

/** mount where a target's content commits (a screen, a sheet's body) when timing is on */
export const Painted = ({ target }: { target: string }) => {
  useLayoutEffect(() => reportPaint(target), [target]);
  return null;
};
