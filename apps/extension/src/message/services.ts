export enum ServicesMessage {
  ClearCache = 'ClearCache',
  ChangeNumeraires = 'ChangeNumeraires',
}

export const isPraxServicesMessage = (msg: unknown): msg is ServicesMessage => {
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

export const CLEAR_CACHE_STEPS: ClearCacheStep[] = [
  'stopping',
  'clearing-params',
  'clearing-database',
  'clearing-sync-state',
  'reloading',
];

export function getClearCacheStepLabel(step: ClearCacheStep): string {
  switch (step) {
    case 'stopping':
      return 'Stopping sync...';
    case 'clearing-params':
      return 'Clearing parameters...';
    case 'clearing-database':
      return 'Clearing transaction database...';
    case 'clearing-sync-state':
      return 'Clearing sync state...';
    case 'reloading':
      return 'Reloading extension...';
    case 'complete':
      return 'Complete';
  }
}
