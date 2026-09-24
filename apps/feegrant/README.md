# feegrant - Injective gas sponsor

Lets a user who holds **USDC.inj but no INJ** shield it into Penumbra. Injective
only accepts INJ for gas, so without this a user who withdrew USDC from an
exchange is stuck until they separately buy INJ.

The service holds one granter account and issues each eligible address a small
[x/feegrant](https://docs.cosmos.network/main/build/modules/feegrant) allowance:

- scoped to `/ibc.applications.transfer.v1.MsgTransfer` only,
- capped at `SPEND_LIMIT` (default 0.001 INJ, about 5 shields),
- expiring after `GRANT_TTL_HOURS` (default 24h).

The client (zafu's Injective panel, Veil's shield dialog) then signs its
MsgTransfer with `fee.granter = <granter>`, and Injective charges the fee to us.

## API

| Method | Path | Response |
|---|---|---|
| GET | `/health` | `{ ok, granter, grantsToday, dailyGrantCap }` |
| GET | `/v1/injective/granter` | `{ granter, spendLimit, grantTtlHours }` - clients probe this to decide whether to offer sponsorship |
| POST | `/v1/injective/grant` `{ address }` | 200 `{ granter, status: 'granted'\|'exists', txhash?, height?, expiresAt? }` |

`POST /grant` answers only once a new grant is **included in a block**, so the
client can use it immediately. Errors: 400 bad address, 409 not eligible
(`no_usdc` / `has_inj`), 429 limits, 503 sponsor low or grant not yet confirmed
(`retryable: true`), 502 chain unreachable.

## Security model

- **Hot key, bounded loss.** The granter mnemonic is loaded from a file into
  memory. Worst case (key stolen or a bug) is the granter's balance. Keep only a
  few INJ in it and top up; `/health` and `ALERT` log lines flag a low balance.
- **Eligibility** (cheapest check first): valid `inj1` address; per-IP request
  rate; per-IP and global daily grant caps; the address holds at least
  `MIN_USDC` USDC.inj; the address holds less than `SPONSOR_BELOW_INJ` INJ (it
  cannot pay its own gas); the granter itself is above `MIN_GRANTER_BALANCE`.
- **Serialized signing.** One key means one sequence number, so grants are
  signed and broadcast strictly one at a time.
- **No client data on disk.** Only the global daily grant count is persisted
  (`STATE_FILE`). Per-IP counters live in memory.

## Privacy

Every grant and every sponsored transfer is public on Injective and names the
granter, so a sponsored shield is visibly made with our tooling. The service
also sees the requester's IP next to the address. The shield transfer itself is
already public on Injective, so this adds a wallet fingerprint, not a new
deanonymization. The clients say so where sponsorship is offered.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `FEEGRANT_MNEMONIC_FILE` | required | path to the granter mnemonic (mode 0600) |
| `FEEGRANT_ACCOUNT_INDEX` | `0` | HD account index of the granter |
| `INJECTIVE_LCD` | `https://sentry.lcd.injective.network` | REST endpoint |
| `HOST` / `PORT` | `127.0.0.1` / `3335` | bind address (keep it behind the proxy) |
| `TRUST_PROXY` | `0` | `1` = take client IP from `X-Forwarded-For` |
| `SPEND_LIMIT` | `1000000000000000` | per-grant allowance, base units (0.001 INJ) |
| `GRANT_TTL_HOURS` | `24` | allowance lifetime |
| `SHIELD_FEE` | `200000000000000` | largest single client fee; below this a grant counts as exhausted |
| `MIN_USDC` | `1000000` | minimum USDC.inj held to qualify (1 USDC) |
| `SPONSOR_BELOW_INJ` | `1000000000000000` | only sponsor addresses holding less INJ than this |
| `DAILY_GRANT_CAP` | `200` | new grants per UTC day, all clients |
| `PER_IP_DAILY_GRANT_CAP` | `3` | new grants per IP per UTC day |
| `PER_IP_REQUESTS_PER_HOUR` | `30` | request rate per IP |
| `MIN_GRANTER_BALANCE` | `100000000000000000` | stop granting below this (0.1 INJ) |
| `STATE_FILE` | `./feegrant-state.json` | persisted daily counter |

Worst-case spend per day with defaults: 200 grants x (0.001 INJ allowance +
~0.00004 INJ grant fee) = about 0.21 INJ.

## Build

```
pnpm --filter @repo/feegrant test
cd apps/feegrant && bun run build     # -> dist/feegrant, one self-contained binary
```

`bun build --compile` bundles the Bun runtime and all dependencies, so the host
needs no Node or Bun.

## Deploy (bkk07 CT 350001, next to license-server)

1. Create a **dedicated** granter wallet (fresh mnemonic, used for nothing
   else). Put the mnemonic in `/root/feegrant/granter.mnemonic`, `chmod 600`.
2. Start the service once and read the granter address from the log line
   `granter inj1...`, then fund it with a few INJ.
3. Copy `dist/feegrant` to `/root/feegrant/feegrant`, and `feegrant.env.example`
   to `/root/feegrant/feegrant.env` (edit as needed).
4. Install `feegrant.service` to `/etc/systemd/system/`, then
   `systemctl daemon-reload && systemctl enable --now feegrant`.
5. Route a public HTTPS hostname to `127.0.0.1:3335` in the reverse proxy
   (set `TRUST_PROXY=1` once the proxy sets `X-Forwarded-For`). The zafu and
   Veil clients point at `https://sponsor.zafu.pro` by default.
6. Verify: `curl https://sponsor.zafu.pro/health`, then shield a small amount
   from an address holding USDC.inj and no INJ.

Upgrades follow the license-server pattern: build, keep a `.bak` of the old
binary, swap, `systemctl restart feegrant`.
