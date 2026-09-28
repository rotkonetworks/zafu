---
'zafu': patch
---

Stop reporting the worker's pre-boot state as a crash. `walletServices` is
undefined until `initHandler` has awaited storage and created the boot services,
and two callers treated it as always-set: the `blockSync` alarm (which fires the
moment a woken worker's script has run, i.e. squarely inside that window) did
`await walletServices` and then dereferenced the undefined result, and the
internal service listener was handed it as a `Promise<Services>`. The alarm case
surfaced in the worker console as `Skipping background sync: TypeError: Cannot
read properties of undefined (reading 'getWalletServices')` - a programming error
wearing the "services not initialized" costume. The variable is now typed as
possibly-undefined, the alarm says what is true (services are still starting, and
the boot path starts the block processor itself), the rebuild teardown skips an
absent predecessor instead of catching a TypeError, and a message that beats the
boot gets an explicit "wallet services are still starting" rejection instead of a
`TypeError`.
