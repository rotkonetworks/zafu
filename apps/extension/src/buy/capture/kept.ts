/**
 * "keep this for my next buy" holds webRequest + scripting, which (with the
 * install's host access) reach every site. So a kept grant is time-limited:
 * it lasts KEEP_DAYS from the buy that kept it, and is given back by the
 * service worker at start and by the buy page when it opens once that time is
 * up. A grant kept before the limit existed is given back at once.
 */
import { readBuyPrefs, writeBuyPrefs } from '../store';
import { releaseCaptureAccess } from './run';

export const KEEP_DAYS = 30;
const KEEP_MS = KEEP_DAYS * 24 * 60 * 60_000;

/** record that the person kept read access for `appId`, from now */
export const keepCaptureAccess = async (appId: string, now = Date.now()): Promise<void> => {
  const kept = new Set((await readBuyPrefs()).kept ?? []);
  await writeBuyPrefs({ kept: [...kept.add(appId)], keptUntil: now + KEEP_MS });
};

/** give the access back now and forget that it was kept */
export const dropCaptureAccess = async (): Promise<void> => {
  await releaseCaptureAccess();
  await writeBuyPrefs({ kept: [], keptUntil: undefined });
};

/** is read access still kept? Gives it back first when its time is up. */
export const keptCaptureAccess = async (now = Date.now()): Promise<boolean> => {
  const { kept, keptUntil } = await readBuyPrefs();
  if (keptUntil && now < keptUntil && kept?.length) {
    return true;
  }
  if (kept?.length || keptUntil) {
    await dropCaptureAccess();
  }
  return false;
};
