/**
 * THORNode's HTTP API, one GET with failover across public nodes. MAYANode
 * serves the same API, so the nodes are a parameter. No egress ask here: each
 * caller wraps it with its own destination (swap quotes and name lookups are
 * separate opt-ins).
 */

export const THORNAME_PATH = '/thorchain/thorname';

export const THORNODE_URLS = [
  'https://thornode.ninerealms.com',
  'https://gateway.liquify.com/chain/thorchain_api',
];

/** a 4xx: the chain answered, so asking the next node changes nothing */
export class ThornodeRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const thornodeGet = async <T>(path: string, urls = THORNODE_URLS): Promise<T> => {
  let last: unknown;
  for (const base of urls) {
    try {
      const resp = await fetch(`${base}${path}`);
      const body = (await resp.json().catch(() => ({}))) as T & {
        message?: string;
        error?: string;
      };
      if (resp.ok) {
        return body;
      }
      // mayanode says `error` where thornode says `message`
      const message = body.message ?? body.error ?? `thornode ${resp.status}`;
      if (resp.status < 500) {
        throw new ThornodeRefusal(message, resp.status);
      }
      last = new Error(message);
    } catch (e) {
      if (e instanceof ThornodeRefusal) {
        throw e;
      }
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error('the node did not answer');
};
