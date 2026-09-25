/* eslint-disable no-console -- service output goes to journald */
/**
 * Injective gas sponsor.
 *
 *   GET  /health                -> { ok, funded, granter, balanceInj, minBalanceInj,
 *                                    grantsToday, dailyGrantCap }; 503 when not ok
 *   GET  /v1/injective/granter  -> { granter, spendLimit, grantTtlHours }
 *   POST /v1/injective/grant    -> { granter, status, txhash?, height?, expiresAt? }
 *
 * Issues small, time-boxed x/feegrant allowances (IBC MsgTransfer only) so a
 * user who holds USDC.inj but no INJ can shield it into Penumbra. See README.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { deriveInjectiveWallet } from '@repo/wallet/networks/injective/derive';
import { queryInjectiveBalances } from '@repo/wallet/networks/injective/client';
import { loadConfig } from './config';
import { Granter } from './granter';
import { Limits } from './limits';
import { handleGrant } from './handler';
import { clientIpFrom } from './client-ip';
import { initGranter } from './init';

const MAX_BODY_BYTES = 1024;

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    // Public API: any wallet or dapp may ask. Abuse is bounded by the limits,
    // not by origin (origins are trivially spoofed outside browsers anyway).
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(body));
};

const readJson = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });

const main = async () => {
  if (process.argv[2] === 'init') {
    await initGranter(process.argv[3]);
    return;
  }
  const config = loadConfig();
  const wallet = await deriveInjectiveWallet(config.mnemonic, config.accountIndex);
  const deps = {
    fetchFn: fetch,
    now: () => new Date(),
    sleep: (ms: number) =>
      new Promise<void>(r => {
        setTimeout(r, ms);
      }),
  };
  const granter = new Granter(wallet, config, deps);
  const limits = new Limits(config);
  const balances = (address: string) =>
    queryInjectiveBalances(config.lcdUrl, address, config.usdcDenom, fetch);

  // Whether the sponsor can actually pay right now. Clients probe
  // /v1/injective/granter to decide whether to OFFER sponsorship, so an
  // unfunded or drained granter must read as unavailable there - otherwise the
  // UI promises "no INJ needed" and then fails at the grant step. Cached so
  // probes don't hit the LCD on every request.
  let balanceCache: { at: number; inj: bigint } | undefined;
  const granterBalance = async (): Promise<bigint> => {
    if (balanceCache && Date.now() - balanceCache.at < 60_000) {
      return balanceCache.inj;
    }
    const inj = (await balances(granter.address)).inj;
    balanceCache = { at: Date.now(), inj };
    return inj;
  };
  const isFunded = async (): Promise<boolean> =>
    (await granterBalance()) >= config.minGranterBalance;
  /** base units (18 decimals) -> INJ, for humans and monitors */
  const toInj = (base: bigint): number => Number(base) / 1e18;

  const clientIp = (req: IncomingMessage): string =>
    clientIpFrom(req.headers['x-forwarded-for'], req.socket.remoteAddress, config.trustProxy);

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0];
      try {
        if (req.method === 'OPTIONS') {
          send(res, 204, {});
        } else if (req.method === 'GET' && path === '/health') {
          // Honest health: "the process answers" is not "sponsorship works".
          // ok = the granter's balance was read and covers the cutoff below
          // which /v1/injective/granter stops offering grants. A monitor can
          // also warn early on balanceInj before it reaches minBalanceInj.
          let balance: bigint | undefined;
          try {
            balance = await granterBalance();
          } catch {
            // LCD unreachable: balance unknown, so not ok
          }
          const funded = balance !== undefined && balance >= config.minGranterBalance;
          const capped = limits.grantsToday >= config.dailyGrantCap;
          const ok = funded && !capped;
          send(res, ok ? 200 : 503, {
            ok,
            funded,
            capped,
            granter: granter.address,
            balanceInj: balance === undefined ? null : toInj(balance),
            minBalanceInj: toInj(config.minGranterBalance),
            grantsToday: limits.grantsToday,
            dailyGrantCap: config.dailyGrantCap,
          });
        } else if (req.method === 'GET' && path === '/v1/injective/granter') {
          let funded = false;
          try {
            funded = await isFunded();
          } catch {
            // LCD unreachable: don't advertise what we can't confirm
          }
          if (!funded) {
            send(res, 503, { error: 'gas sponsorship is temporarily unavailable' });
            return;
          }
          send(res, 200, {
            granter: granter.address,
            spendLimit: config.spendLimit.toString(),
            grantTtlHours: config.grantTtlMs / 3_600_000,
          });
        } else if (req.method === 'POST' && path === '/v1/injective/grant') {
          let body: unknown;
          try {
            body = await readJson(req);
          } catch (e) {
            send(res, 400, { error: e instanceof Error ? e.message : 'bad request' });
            return;
          }
          const result = await handleGrant(
            {
              config,
              granterAddress: granter.address,
              ensureGrant: (g, t) => granter.ensureGrant(g, t),
              admit: ip => limits.admit(ip),
              recordGrant: ip => limits.recordGrant(ip),
              balances,
              log,
            },
            clientIp(req),
            body,
          );
          send(res, result.status, result.body);
        } else {
          send(res, 404, { error: 'not found' });
        }
      } catch (e) {
        log(`unhandled: ${e instanceof Error ? e.message : String(e)}`);
        send(res, 500, { error: 'internal error' });
      }
    })();
  });

  server.listen(config.port, config.host, () => {
    // Public address only - the mnemonic/private key are never logged.
    log(`feegrant listening on ${config.host}:${config.port}, granter ${granter.address}`);
  });

  void balances(granter.address)
    .then(b => log(`granter balance: ${b.inj} base units INJ`))
    .catch((e: unknown) =>
      log(`could not read granter balance: ${e instanceof Error ? e.message : String(e)}`),
    );

  const shutdown = () => {
    wallet.privateKey.fill(0);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

void main().catch((e: unknown) => {
  console.error(`feegrant failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
