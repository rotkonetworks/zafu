# CHANGELOG

full release history lives in the git tags and github releases. the current
version is **28.1.0**. a few recent highlights (from `git log`):

- **zcash voting** - active/past tabs on the zcash vote screen; test rounds hidden
- **error recovery** - route error boundary plus a guarded one-shot auto-reload for
  stale lazy chunks after a chrome auto-update
- **storage migrations** - local storage migrations attached at construction so the
  popup, options page, and service worker realms all run them
- **injective** - native-usdc (`USDC.inj`) ramp wired as a penumbra subnetwork, held
  `launched: false` until the ibc path is actively relayed
- **penumbra sends** - spend-all "max" button that reserves the um fee and leaves no
  dust change notes

for the authoritative list see <https://github.com/rotkonetworks/zafu/releases>.
