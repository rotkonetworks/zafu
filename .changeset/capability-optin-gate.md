---
'zafu': patch
---

A capability can now be switched off globally, and asking is not refusing.

- Every capability a site can request (`zafu_request_capability`, the FROST /
  multisig requests, `zafu_open_shield`, and both passkey calls) now has a
  **global** state - `enabled`, `disabled`, or undecided - separate from the
  long-standing per-site grant. The gate over a site request is the pure
  `decideCapabilityUse({ mode, grantedToOrigin })`: off refuses every site
  including one that already holds a grant (turning a capability off is a
  revocation, not a hint); `enabled` + grant allows; `enabled` without a grant
  falls back to the existing per-site prompt; and **`unset` asks** - a fresh
  install is not an opt-out.
- The first request for a capability from any site raises one plain question
  ("does zafu do this at all?"), separate from the per-site consent prompt:
  different question, different copy, different persistence. The answer is
  sticky, so it is asked once and only once.
- The global question is asked _before_ anything site-bound, so a site that has
  switched a capability off is never shown a consent prompt for it, and a locked
  wallet is never shown the passkey consent screen before the unlock.
- Settings gains a **Features** screen listing each capability with its state,
  so a capability turned off from a prompt is visible and reversible.
- `utils/capability-decision.ts` holds the decision as a pure function of
  explicit state (no `chrome.*`, no storage, no prompts) so the table above is
  unit-testable; the message listener supplies the state and executes the
  decision.
