# @zafu/protocol

The versioned, transport-agnostic contract for the `zafu_*` wallet ↔ dapp API - the shared source of truth that the [zafu wallet](https://zafu.pro) and the [`@zafu/zid`](https://www.npmjs.com/package/@zafu/zid) SDK are both checked against.

Most apps want **[`@zafu/zid`](https://www.npmjs.com/package/@zafu/zid)**, not this package directly. Reach for `@zafu/protocol` when you are building your own client or a non-extension transport and want the typed request/response shapes and the version constant.

## Install

```sh
npm install @zafu/protocol
```

## What's in it

- **`ZAFU_PROTOCOL_VERSION`** / `ZAFU_SUPPORTED_PROTOCOL_VERSIONS` - the wire-protocol major(s), negotiated over the `ping` handshake.
- **Method types** - typed request/response shapes for the v1 surface: `ping`, `zafu_sign`, `zafu_zid_pubkey`, `zafu_request_capability`, `zafu_encrypt`, `zafu_decrypt`, `zafu_pick_contacts`. `ZAFU_V1_METHODS` lists them; `ZafuRequest<M>` / `ZafuResponse<M>` map a method to its shapes.
- **`ZafuTransport`** - the pluggable transport interface. The message shapes say *what* crosses the wire; a transport says *how* it gets there (an extension bridge today; a relay or native host tomorrow).

```ts
import {
  ZAFU_PROTOCOL_VERSION,
  isZafuError,
  type ZafuTransport,
  type ZafuRequest,
  type ZafuResponse,
} from '@zafu/protocol';

async function zidPubkey(t: ZafuTransport) {
  const resp = await t.request('zafu_zid_pubkey', { type: 'zafu_zid_pubkey' });
  if (isZafuError(resp)) throw new Error(resp.error);
  return resp.pubkey; // hex ed25519, plus resp.pq_pubkey for post-quantum
}
```

The shapes describe the wire **faithfully**, including the historical per-method response inconsistencies; a higher-level SDK (`@zafu/zid`) normalises them into typed-or-throw calls.

## Post-quantum

Confidentiality-bearing methods carry an additive post-quantum path (`pq_pubkey` on `zafu_zid_pubkey`, `recipient_pq` on `zafu_encrypt`) using the hybrid X25519 + ML-KEM-768 KEM from [`@zafu/pq`](https://www.npmjs.com/package/@zafu/pq). Additive: pre-PQ wallets simply omit the fields.

## License

MIT
