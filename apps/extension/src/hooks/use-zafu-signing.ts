/**
 * hook for zafu signing flow
 */

import { useStore } from '../state';
import { zafuSigningSelector } from '../state/zafu-signing';

export function useZafuSigning() {
  return useStore(zafuSigningSelector);
}
