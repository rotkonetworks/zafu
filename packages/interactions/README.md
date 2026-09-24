# @zafu/interactions

The app side of asking a wallet for something: connect, sign, approve.

Most apps get these wrong in the same three ways. This package fixes each once:

- **Double requests.** A second click sent the wallet a second approval. Here, a request with the same key joins the one already in flight.
- **Timers that lie.** Apps gave up after a few seconds and said "wallet didn't respond" while the user was still typing their password. Here, nothing times out: after `slowAfterMs` (default 15s) the status turns `slow`, and the request keeps waiting for the wallet's real answer.
- **Nothing to render.** Every interaction has a status: `waiting`, then `slow`, then `done` or `failed`.

Where the wallet shows the request (side panel or popup window) is the wallet's decision, from its user's settings. Nothing here lets an app choose.

You probably don't need this package directly: [`@zafu/zid`](../zid)'s `connect()` is built on it. Use it when you wrap your own wallet calls.

```ts
import { interaction, interactionKey } from '@zafu/interactions';

const signing = interaction(interactionKey('sign', challenge), () => wallet.sign(challenge), {
  onStatus: s => {
    if (s === 'waiting') label.textContent = 'Approve in your wallet...';
    if (s === 'slow') label.textContent = 'Still waiting - click the wallet icon in your toolbar';
  },
});
const signature = await signing.result; // rejects with whatever the wallet threw
```

## API

| | |
|---|---|
| `interaction(key, run, { slowAfterMs?, onStatus? })` | Start `run`, or join the interaction already in flight under `key`. Returns `{ key, status, result, subscribe }`. |
| `interactionKey(...parts)` | A stable key: JSON with sorted object keys, bytes as hex. |
| `currentInteraction(key)` | The interaction in flight under `key`, if any. |

Dependency-free: no chrome, no DOM.

## License

MIT
