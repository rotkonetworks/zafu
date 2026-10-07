/**
 * What a failed camera start means, said calmly. getUserMedia rejects with a
 * DOMException whose name is stable across browsers while its message is not
 * (Brave and Chromium word a denial differently, and the raw text is
 * capitalised English), so the name decides first and the message is only a
 * fallback for wrapped errors.
 */

export type CameraTrouble = 'permission' | 'in-use' | 'missing' | 'other';

const BY_NAME: Record<string, CameraTrouble> = {
  NotAllowedError: 'permission',
  PermissionDeniedError: 'permission',
  SecurityError: 'permission',
  NotReadableError: 'in-use',
  TrackStartError: 'in-use',
  AbortError: 'in-use',
  NotFoundError: 'missing',
  DevicesNotFoundError: 'missing',
  OverconstrainedError: 'missing',
};

const BY_MESSAGE: [RegExp, CameraTrouble][] = [
  [/permission|notallowed|denied/i, 'permission'],
  [/notreadable|could not start|in use/i, 'in-use'],
  [/notfound|no camera|overconstrained/i, 'missing'],
];

export const CAMERA_LINE: Record<CameraTrouble, string> = {
  permission: "zafu can't use the camera · allow it in the browser's site settings, then try again",
  'in-use': 'another app is using the camera · please close it, then try again',
  missing: 'no camera was found · please connect one, then try again',
  other: "the camera didn't start · please try again",
};

export const cameraTrouble = (err: unknown): CameraTrouble => {
  // a DOMException is not an Error in every realm, so read the fields as they come
  const { name = '', message = String(err ?? '') } = (err ?? {}) as {
    name?: string;
    message?: string;
  };
  return BY_NAME[name] ?? BY_MESSAGE.find(([re]) => re.test(message))?.[1] ?? 'other';
};

export const cameraLine = (err: unknown): string => CAMERA_LINE[cameraTrouble(err)];
