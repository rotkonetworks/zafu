/**
 * Installs the dev-only transport console quieting from a SYNC module.
 *
 * Every entry that can run the transport client - the worker and the extension
 * pages - is an async webpack module: it transitively imports wasm, so webpack
 * hoists the requires, awaits the async deps, and only then runs the entry body.
 * The transport client (`clients.ts`) is in the graph of those same entries and
 * can log before that await resolves - a live boot probe finds the side panel
 * still holding the native `console.warn` at the `load` event. So the install
 * has to happen during the hoisted, synchronous require phase: import this
 * module FIRST in the entry, and its side effect lands before any deferred
 * dependency's body.
 *
 * This module imports nothing (`session-client-noise` is a pure util), so it
 * never becomes an async module itself - the same mechanism
 * `install-global-error-handlers.ts` uses for the worker's global error
 * listeners, which Chrome insists are registered during the worker's initial
 * synchronous evaluation.
 */
import { silenceSessionClientNoise } from './utils/session-client-noise';

silenceSessionClientNoise();
