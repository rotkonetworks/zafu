import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import { AllSlices, SliceCreator } from '.';

export interface TradingModeSettings {
  autoSign: boolean;
  allowedOrigins: string[];
  sessionDurationMinutes: number;
  expiresAt: number;
  maxValuePerSwap: string;
}

export interface TradingModeSlice {
  settings: TradingModeSettings;
  setAutoSign: (enabled: boolean) => void;
  addAllowedOrigin: (origin: string) => void;
  removeAllowedOrigin: (origin: string) => void;
  setSessionDuration: (minutes: number) => void;
  setMaxValuePerSwap: (value: string) => void;
  startSession: () => void;
  endSession: () => void;
  isSessionActive: () => boolean;
  saveTradingMode: () => Promise<void>;
  canAutoSign: (origin?: string) => boolean;
}

const DEFAULT_SETTINGS: TradingModeSettings = {
  autoSign: false,
  allowedOrigins: [],
  sessionDurationMinutes: 30,
  expiresAt: 0,
  maxValuePerSwap: '0',
};

export const createTradingModeSlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<TradingModeSlice> =>
  (set, get) => ({
    settings: DEFAULT_SETTINGS,

    setAutoSign: (enabled: boolean) => {
      set(state => {
        state.tradingMode.settings.autoSign = enabled;
        if (!enabled) {
          state.tradingMode.settings.expiresAt = 0;
        }
      });
    },

    addAllowedOrigin: (origin: string) => {
      set(state => {
        if (!state.tradingMode.settings.allowedOrigins.includes(origin)) {
          state.tradingMode.settings.allowedOrigins.push(origin);
        }
      });
    },

    removeAllowedOrigin: (origin: string) => {
      set(state => {
        const idx = state.tradingMode.settings.allowedOrigins.indexOf(origin);
        if (idx >= 0) {
          state.tradingMode.settings.allowedOrigins.splice(idx, 1);
        }
      });
    },

    setSessionDuration: (minutes: number) => {
      set(state => {
        state.tradingMode.settings.sessionDurationMinutes = Math.max(1, Math.min(480, minutes));
      });
    },

    setMaxValuePerSwap: (value: string) => {
      set(state => {
        state.tradingMode.settings.maxValuePerSwap = value;
      });
    },

    startSession: () => {
      set(state => {
        const durationMs = state.tradingMode.settings.sessionDurationMinutes * 60 * 1000;
        state.tradingMode.settings.expiresAt = Date.now() + durationMs;
      });
    },

    endSession: () => {
      set(state => {
        state.tradingMode.settings.expiresAt = 0;
      });
    },

    isSessionActive: () => {
      const { autoSign, expiresAt, allowedOrigins } = get().tradingMode.settings;
      return autoSign && allowedOrigins.length > 0 && expiresAt > Date.now();
    },

    saveTradingMode: async () => {
      await local.set('tradingMode', get().tradingMode.settings);
    },

    canAutoSign: (origin?: string) => {
      const { autoSign, allowedOrigins, expiresAt } = get().tradingMode.settings;
      if (!autoSign) return false;
      if (allowedOrigins.length === 0) return false;
      if (expiresAt <= Date.now()) return false;
      if (origin && !allowedOrigins.includes(origin)) return false;
      return true;
    },
  });

export const tradingModeSelector = (state: AllSlices) => state.tradingMode;
