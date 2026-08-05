// Small helpers to bridge the SDK's RxJS observables to promises.
//
// Every SignerZcash method (and dmk.executeDeviceAction) returns a
// DeviceAction: `{ observable, cancel }` emitting DeviceActionState values
// until it reaches a terminal `Completed` / `Error` / `Stopped` state, after
// which the observable completes. These helpers await the terminal state so
// callers can use plain async/await.
//
// NOTE ON NARROWING: `DeviceActionStatus` is a runtime *enum* in the SDK, so
// comparing `state.status` against string literals is not type-safe, and
// importing the enum as a value would pull the whole DMK (inversify + xstate)
// into the main bundle. Instead we narrow structurally on the discriminated
// union's payload (`output` / `error`) and treat "observable completed without
// a terminal payload" as a cancel/stop. That is fail-closed: an unrecognised
// terminal state rejects, it never resolves with a missing signature.

import type {
  DeviceActionIntermediateValue,
  DmkError,
  ExecuteDeviceActionReturnType,
} from '@ledgerhq/device-management-kit';

/** Structural view of an rxjs Observable - avoids a value-level rxjs import. */
export interface MinimalObservable<T> {
  subscribe(observer: {
    next?: (value: T) => void;
    error?: (err: unknown) => void;
    complete?: () => void;
  }): { unsubscribe(): void };
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (value == null) {
    return new Error(fallback);
  }
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

/** Resolve with the DeviceAction's output, or reject on error/user-cancel. */
export function runDeviceAction<
  Output,
  Err extends DmkError,
  Intermediate extends DeviceActionIntermediateValue,
>(action: ExecuteDeviceActionReturnType<Output, Err, Intermediate>): Promise<Output> {
  return new Promise<Output>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;

    const finish = (fn: () => void): void => {
      settled = true;
      fn();
      unsubscribe?.();
    };

    const subscription = action.observable.subscribe({
      next(state) {
        if (settled) {
          return;
        }
        if ('output' in state) {
          finish(() => resolve(state.output));
        } else if ('error' in state) {
          finish(() => reject(toError(state.error, 'ledger device action failed')));
        }
        // not-started / pending: keep waiting.
      },
      error(err) {
        if (!settled) {
          finish(() => reject(toError(err, 'ledger device action errored')));
        }
      },
      complete() {
        // Terminal `stopped` (user cancel on device) completes the observable
        // without ever emitting an output. Never resolve here.
        if (!settled) {
          finish(() => reject(new Error('ledger device action stopped (cancelled on device)')));
        }
      },
    });

    unsubscribe = () => subscription.unsubscribe();
    // Guard against a synchronous terminal emit before assignment above.
    if (settled) {
      unsubscribe();
    }
  });
}

/** Resolve with the first value an observable emits, then unsubscribe. */
export function firstFromObservable<T>(observable: MinimalObservable<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;

    const finish = (fn: () => void): void => {
      settled = true;
      fn();
      unsubscribe?.();
    };

    const subscription = observable.subscribe({
      next(value) {
        if (!settled) {
          finish(() => resolve(value));
        }
      },
      error(err) {
        if (!settled) {
          finish(() => reject(toError(err, 'ledger observable errored')));
        }
      },
      complete() {
        if (!settled) {
          finish(() => reject(new Error('ledger observable completed with no value')));
        }
      },
    });

    unsubscribe = () => subscription.unsubscribe();
    if (settled) {
      unsubscribe();
    }
  });
}
