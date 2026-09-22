/**
 * MV3 requires the service worker's global `error` and `unhandledrejection`
 * listeners to be registered during the INITIAL synchronous evaluation of the
 * worker script - not inside an async callback, after an await, or after a
 * dynamic import. Otherwise Chrome logs:
 *   "Event handler of 'unhandledrejection' event must be added on the initial
 *    evaluation of worker script"
 *
 * The webpack worker build sets `experiments.asyncWebAssembly: true`, so every
 * module that (transitively) imports a `.wasm` becomes an async webpack module,
 * and the service-worker entry - which pulls in the wasm-backed rpc/wallet
 * services - inherits that. Webpack's async-module wrapper runs the hoisted
 * `__webpack_require__` calls first, then AWAITS the async deps, and only THEN
 * runs the entry's own body. So a registration in the entry body (however early)
 * runs after that await - past the initial evaluation - which is exactly the
 * warning above.
 *
 * The fix: register from the top level of a SYNC module (this file imports only
 * `graceful-network-errors`, which imports nothing), and import it FIRST in the
 * entry. Its side effect runs inside its own synchronous `__webpack_require__`,
 * before the entry awaits any wasm dep - i.e. during the initial evaluation.
 *
 * Do not make `graceful-network-errors` self-register on import instead: it is
 * also imported by other worker entries (offscreen, wasm-build) and would then
 * double-register there.
 */
import { installGracefulNetworkErrorHandler } from './utils/graceful-network-errors';

installGracefulNetworkErrorHandler();
