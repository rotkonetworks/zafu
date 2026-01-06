/**
 * hook for zigner signing flow
 */

import { useStore } from '../state';
import { zignerSigningSelector } from '../state/zigner-signing';

export function useZignerSigning() {
  return useStore(zignerSigningSelector);
}
