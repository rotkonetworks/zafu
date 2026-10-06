import { describe, expect, it } from 'vitest';
import { CAMERA_LINE, cameraLine, cameraTrouble } from './camera-error';

const dom = (name: string, message = 'whatever the browser says') =>
  new DOMException(message, name);

describe('cameraTrouble', () => {
  it('reads the DOMException name first, whatever the message says', () => {
    expect(cameraTrouble(dom('NotAllowedError', 'Permission denied'))).toBe('permission');
    expect(cameraTrouble(dom('SecurityError'))).toBe('permission');
    expect(cameraTrouble(dom('NotReadableError', 'Permission denied'))).toBe('in-use');
    expect(cameraTrouble(dom('NotFoundError'))).toBe('missing');
    expect(cameraTrouble(dom('OverconstrainedError'))).toBe('missing');
  });

  it('falls back to the message for wrapped errors', () => {
    expect(cameraTrouble(new Error('Permission denied'))).toBe('permission');
    expect(cameraTrouble(new Error('no camera found'))).toBe('missing');
    expect(cameraTrouble(new Error('Could not start video source'))).toBe('in-use');
    expect(cameraTrouble(new Error('something else'))).toBe('other');
    expect(cameraTrouble(undefined)).toBe('other');
  });
});

describe('cameraLine', () => {
  it('never hands back the raw browser text', () => {
    expect(cameraLine(dom('NotAllowedError', 'Permission denied'))).toBe(CAMERA_LINE.permission);
    expect(cameraLine(new Error('Some Raw Failure'))).toBe(CAMERA_LINE.other);
  });

  it('speaks lowercase, calm and without exclamation', () => {
    for (const line of Object.values(CAMERA_LINE)) {
      expect(line).toBe(line.toLowerCase());
      expect(line).not.toMatch(/!/);
    }
  });
});
