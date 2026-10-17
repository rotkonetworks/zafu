// the policy's own answer for a recorded request: reads {inputs, requests:[{url, realm}]} on stdin
import type { EgressInputs } from '../src/net/egress-policy';
import type { EgressRealm } from '../src/net/egress-table';
// the policy's imports touch chrome.storage at load; nothing here reads it
const area = {
  get: async () => ({}),
  set: async () => undefined,
  onChanged: { addListener: () => undefined },
};
(globalThis as Record<string, unknown>)['chrome'] = {
  storage: { local: area, session: area, onChanged: { addListener: () => undefined } },
  runtime: { id: 'harness', getURL: (p: string) => p, onMessage: { addListener: () => undefined } },
};
let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', async () => {
  const { compileEgress } = await import('../src/net/egress-policy');
  const { decideEgress } = await import('../src/net/egress-table');
  const { nymPlan } = await import('../src/net/nym-plan');
  const { inputs, unlocked, requests } = JSON.parse(raw) as {
    inputs: EgressInputs;
    unlocked: boolean;
    requests: { url: string; realm: EgressRealm }[];
  };
  const table = compileEgress(inputs);
  const plan = nymPlan({
    keepReady: table.nymKeepReady === true,
    carries: !!table.nymVia?.length,
    master: table.nym === true,
    unlocked,
  });
  const decisions = requests.map(r => decideEgress(r.url, r.realm, table));
  process.stdout.write(JSON.stringify({ plan, nymVia: table.nymVia, nym: table.nym, decisions }));
});
