import { AllSlices, SliceCreator } from '.';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';

export interface AirgapSignerSlice {
  cameraEnabled: boolean;
  setCameraEnabled: (enabled: boolean) => void;
}

export const createAirgapSignerSlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<AirgapSignerSlice> =>
  set => ({
    cameraEnabled: false,
    setCameraEnabled: enabled => {
      set(state => {
        state.airgapSigner.cameraEnabled = enabled;
      });

      void local.set('airgapSignerCameraEnabled', enabled);
    },
  });

export const airgapSignerSelector = (state: AllSlices) => state.airgapSigner;
