/**
 * Camera permission utilities for QR scanning
 */

export type CameraPermissionState = 'granted' | 'denied' | 'prompt' | 'unknown';

/**
 * Check current camera permission state
 */
export async function checkCameraPermission(): Promise<CameraPermissionState> {
  try {
    // Try the Permissions API first
    const permission = await navigator.permissions.query({
      name: 'camera' as PermissionName,
    });
    return permission.state as CameraPermissionState;
  } catch {
    // Firefox doesn't support querying camera permission
    // Fall back to checking if video devices have labels
    // (labels are only populated if permission was previously granted)
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasLabeledCamera = devices.some(
        d => d.kind === 'videoinput' && d.label.length > 0
      );
      return hasLabeledCamera ? 'granted' : 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

/**
 * Request camera permission from user.
 * This will trigger the browser's permission prompt if not already decided.
 *
 * @returns Object with success status and error details
 */
export async function requestCameraPermission(): Promise<{
  granted: boolean;
  wasDenied: boolean;
  error?: string;
}> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    // Stop all tracks immediately - we just needed to trigger the permission
    stream.getTracks().forEach(track => track.stop());
    return { granted: true, wasDenied: false };
  } catch (error) {
    const err = error as Error;
    const isDenied = err.name === 'NotAllowedError' || err.message.includes('denied');

    console.error('Camera permission error:', err.name, err.message);

    return {
      granted: false,
      wasDenied: isDenied,
      error: isDenied
        ? 'Camera access was denied. Please enable it in your browser settings.'
        : err.message || 'Failed to access camera',
    };
  }
}

/**
 * Subscribe to camera permission changes
 */
export function onCameraPermissionChange(
  callback: (state: CameraPermissionState) => void
): () => void {
  let cleanup: (() => void) | undefined;

  navigator.permissions
    .query({ name: 'camera' as PermissionName })
    .then(permission => {
      const handler = () => callback(permission.state as CameraPermissionState);
      permission.addEventListener('change', handler);
      cleanup = () => permission.removeEventListener('change', handler);
    })
    .catch(() => {
      // Firefox - no permission change events available
    });

  return () => cleanup?.();
}

/**
 * Get instructions for enabling camera in browser settings
 */
export function getCameraSettingsInstructions(): string {
  const isChrome = /Chrome/.test(navigator.userAgent) && !/Edge/.test(navigator.userAgent);
  const isFirefox = /Firefox/.test(navigator.userAgent);
  const isEdge = /Edge/.test(navigator.userAgent);

  if (isChrome) {
    return 'Click the lock/tune icon in the address bar → Site settings → Camera → Allow';
  } else if (isFirefox) {
    return 'Click the lock icon in the address bar → Clear permission for camera → Try again';
  } else if (isEdge) {
    return 'Click the lock icon in the address bar → Permissions → Camera → Allow';
  }
  return 'Check your browser settings to enable camera access for this site.';
}
