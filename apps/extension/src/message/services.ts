export enum ServicesMessage {
  ClearCache = 'ClearCache',
  ChangeNumeraires = 'ChangeNumeraires',
}

/** Network-scoped clear cache request */
export interface ClearCacheRequest {
  type: 'ClearCache';
  network: 'penumbra' | 'zcash';
}

export const isClearCacheRequest = (msg: unknown): msg is ClearCacheRequest =>
  typeof msg === 'object' &&
  msg !== null &&
  'type' in msg &&
  (msg as { type: string }).type === 'ClearCache' &&
  'network' in msg;

export const isZignerServicesMessage = (msg: unknown): msg is ServicesMessage => {
  return typeof msg === 'string' && Object.values(ServicesMessage).includes(msg as ServicesMessage);
};

/**
 * Cache clearing progress updates sent via chrome.runtime.sendMessage
 */
export interface ClearCacheProgress {
  type: 'ClearCacheProgress';
  step: ClearCacheStep;
  completed: number;
  total: number;
}

export type ClearCacheStep =
  | 'stopping'
  | 'clearing-params'
  | 'clearing-database'
  | 'clearing-sync-state'
  | 'reloading'
  | 'complete';

export const PENUMBRA_CLEAR_STEPS: ClearCacheStep[] = [
  'stopping',
  'clearing-params',
  'clearing-database',
  'clearing-sync-state',
  'reloading',
];

export const ZCASH_CLEAR_STEPS: ClearCacheStep[] = [
  'clearing-database',
  'clearing-sync-state',
  'reloading',
];

export function getClearCacheStepLabel(step: ClearCacheStep): string {
  switch (step) {
    case 'stopping':
      return 'stopping sync...';
    case 'clearing-params':
      return 'clearing parameters...';
    case 'clearing-database':
      return 'clearing transaction database...';
    case 'clearing-sync-state':
      return 'clearing sync state...';
    case 'reloading':
      return 'reloading extension...';
    case 'complete':
      return 'complete';
  }
}
