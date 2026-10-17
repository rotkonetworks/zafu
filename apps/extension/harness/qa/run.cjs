// release QA runner. usage (repo root, after a build):
//   node apps/extension/harness/qa/run.cjs <dist> <out> [--only s2,i2] [--testnet] [--results file]
//     [--tn dir] [--v282 dir] [--leak dir]   (--v282: the unpacked v28.2.0 release zip, for the
//     upgrade check; --leak: an egress-leak.cjs run on the same build, for v6 and v7)
// every check runs on <dist>; a failing check runs once more before it counts. the results JSON
// ({ id: { status, note } }) is rewritten after each check, so a crash keeps what ran.
// --testnet runs the money checks on a ZAFU_TESTNET=1 build (TAZ only, needs --tn <dir> with
// seed.txt, seed-b.txt, seed-c.txt, password.txt and the synced profiles from testnet.cjs).
const path = require('path'),
  fs = require('fs');

const args = process.argv.slice(2);
const flag = n => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const [dist, out] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const testnet = args.includes('--testnet');
const only = flag('--only')?.split(',');
const resultsFile = flag('--results') ?? path.join(out ?? '.', 'results.json');

const GROUPS = testnet
  ? ['money']
  : ['install', 'zcash', 'swap', 'penumbra', 'people', 'privacy', 'settings', 'dapp', 'look'];

const ctxFor = (id, retry) => {
  const dir = path.join(out, id, retry ? 'retry' : '');
  fs.mkdirSync(dir, { recursive: true });
  return {
    dist: path.resolve(dist),
    dir,
    out: path.resolve(out),
    tn: flag('--tn'),
    v282: flag('--v282'),
    leak: flag('--leak'),
    shot: (pg, n) => pg.screenshot({ path: path.join(dir, n + '.png') }).catch(() => undefined),
    file: (n, s) =>
      fs.writeFileSync(path.join(dir, n), typeof s === 'string' ? s : JSON.stringify(s, null, 1)),
  };
};

const runOne = async (id, check, retry) => {
  const c = ctxFor(id, retry);
  try {
    const r = await Promise.race([
      check.run(c),
      new Promise((_, j) => setTimeout(() => j(new Error('timed out')), check.timeout ?? 600_000)),
    ]);
    return { status: r.status ?? 'pass', note: r.note };
  } catch (e) {
    c.file('error.txt', String(e.stack ?? e));
    return {
      status: 'fail',
      note: `threw: ${String(e.message).split('\n')[0]} (${c.dir}/error.txt)`,
    };
  }
};

// a check that leaves a page promise behind must not take the whole run down with it
process.on('unhandledRejection', e =>
  console.error('unhandled (ignored):', String(e).split('\n')[0]),
);

(async () => {
  if (!dist || !out) {
    console.error(
      'usage: run.cjs <dist> <out> [--only ids] [--testnet] [--tn dir] [--results file]',
    );
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true });
  const results = fs.existsSync(resultsFile)
    ? JSON.parse(fs.readFileSync(resultsFile, 'utf8'))
    : {};
  const build = `${testnet ? 'testnet ' : ''}${path.basename(path.resolve(dist))} ${JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8')).version}`;
  for (const g of GROUPS) {
    const file = path.join(__dirname, `checks-${g}.cjs`);
    const checks = fs.existsSync(file) ? require(file) : {};
    for (const [id, check] of Object.entries(checks)) {
      if (!check?.run || (only && !only.includes(id))) {
        continue;
      }
      const t0 = Date.now();
      let r = await runOne(id, check);
      if (r.status === 'fail' && !check.noRetry) {
        const first = r.note;
        r = await runOne(id, check, true);
        r.note =
          r.status === 'fail'
            ? `${r.note} [failed twice; first: ${first}]`
            : `${r.note} [passed on re-run; first: ${first}]`;
      }
      results[id] = { status: r.status, note: `[${build}] ${check.title}: ${r.note}` };
      fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1));
      console.log(`${r.status.padEnd(5)} ${id} ${Math.round((Date.now() - t0) / 1000)}s ${r.note}`);
    }
    // a group's shared browser, if it kept one
    await checks.done?.();
  }
  process.exit(0);
})().catch(e => {
  console.error('FAIL', e.stack);
  process.exit(1);
});
