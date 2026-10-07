/**
 * What a zcash node says it is, for people to read. Everything here comes from
 * the node's own GetLightdInfo answer (which any node can fill in as it likes)
 * plus how this browser reached it, so it describes the node; it proves
 * nothing. The chain check (fly-verify.ts) is what proves.
 */
import type { LightdInfo } from './lightd-info';

export type NodeKind = 'zidecar' | 'lightwalletd' | 'zaino' | 'unknown';

export interface NodeInfo {
  kind: NodeKind;
  /** the server software's own version, when the node says it */
  version?: string;
  /** the commit it was built from, full or short hex */
  commit?: string;
  /** the source for that version: the exact commit when known, else the release */
  codeUrl?: string;
  /** the full node behind it, e.g. "Zebra 6.4.2" */
  fullNode?: string;
  /** how this browser reached it, e.g. "HTTP/3"; absent when not measured */
  protocol?: string;
}

const KIND_LABEL: Record<NodeKind, string> = {
  zidecar: 'zidecar',
  lightwalletd: 'lightwalletd',
  zaino: 'zaino',
  unknown: 'unknown server',
};

const REPO: Partial<Record<NodeKind, string>> = {
  zidecar: 'https://github.com/rotkonetworks/zcli',
  lightwalletd: 'https://github.com/zcash/lightwalletd',
  zaino: 'https://github.com/zingolabs/zaino',
};

const HEX_COMMIT = /^[0-9a-f]{7,40}$/i;
const VERSION = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

export const nodeKindOf = (vendor: string): NodeKind => {
  const v = vendor.trim().toLowerCase();
  if (v.startsWith('zidecar')) {
    return 'zidecar';
  }
  if (v.includes('zaino')) {
    return 'zaino';
  }
  if (v.includes('lightwalletd')) {
    return 'lightwalletd';
  }
  return 'unknown';
};

/** "/Zebra:6.4.2/" -> "Zebra 6.4.2"; "/MagicBean:6.0.0/" -> "zcashd 6.0.0" */
export const fullNodeOf = (subversion: string): string | undefined => {
  const m = /^\/?([A-Za-z][\w.-]*):([\w.+-]+)\/?/.exec(subversion.trim());
  if (!m) {
    return undefined;
  }
  const name = m[1] === 'MagicBean' ? 'zcashd' : m[1]!;
  return `${name} ${m[2]}`;
};

/**
 * Version and commit. zidecar puts "v<version>-<commit>" in gitCommit and a
 * lightwalletd-compatible number in version, so its own version comes from
 * gitCommit. lightwalletd and Zaino put their version in version and a bare
 * commit in gitCommit.
 */
const versionAndCommit = (
  kind: NodeKind,
  info: Pick<LightdInfo, 'version' | 'gitCommit'>,
): { version?: string; commit?: string } => {
  const git = info.gitCommit.trim();
  if (kind === 'zidecar') {
    const dash = git.lastIndexOf('-');
    const ver = dash > 0 ? VERSION.exec(git.slice(0, dash))?.[1] : undefined;
    const commit = dash > 0 ? git.slice(dash + 1) : undefined;
    return {
      ...(ver && { version: ver }),
      ...(commit && HEX_COMMIT.test(commit) && { commit: commit.toLowerCase() }),
    };
  }
  const ver = VERSION.exec(info.version.trim())?.[1];
  return {
    ...(ver && { version: ver }),
    ...(HEX_COMMIT.test(git) && { commit: git.toLowerCase() }),
  };
};

const codeUrlOf = (kind: NodeKind, version?: string, commit?: string): string | undefined => {
  const repo = REPO[kind];
  if (!repo) {
    return undefined;
  }
  const ref = commit ?? (version ? `v${version}` : undefined);
  if (!ref) {
    return repo;
  }
  return kind === 'zidecar' ? `${repo}/tree/${ref}/bin/zidecar` : `${repo}/tree/${ref}`;
};

export const describeNode = (
  info: Pick<LightdInfo, 'vendor' | 'version' | 'gitCommit' | 'zcashdSubversion'>,
  protocol?: string,
): NodeInfo => {
  const kind = nodeKindOf(info.vendor);
  const { version, commit } = versionAndCommit(kind, info);
  const codeUrl = codeUrlOf(kind, version, commit);
  const fullNode = fullNodeOf(info.zcashdSubversion);
  return {
    kind,
    ...(version && { version }),
    ...(commit && { commit }),
    ...(codeUrl && { codeUrl }),
    ...(fullNode && { fullNode }),
    ...(protocol && { protocol }),
  };
};

/** "zidecar 0.10.0 · cac9b67" */
export const nodeLabel = (n: NodeInfo): string =>
  [KIND_LABEL[n.kind], n.version, n.commit?.slice(0, 7)].filter(Boolean).join(' · ');

/** resource timing's nextHopProtocol, for people: "h3" -> "HTTP/3" */
export const protocolLabel = (nextHop: string | undefined): string | undefined => {
  const p = nextHop?.trim().toLowerCase();
  if (!p) {
    return undefined;
  }
  if (p === 'h3' || p.startsWith('h3-')) {
    return 'HTTP/3';
  }
  if (p === 'h2' || p === 'h2c') {
    return 'HTTP/2';
  }
  if (p.startsWith('http/1')) {
    return 'HTTP/1.1';
  }
  return undefined;
};

/**
 * The protocol of this context's latest finished request to `serverUrl`, from
 * resource timing. Undefined when nothing was measured: the browser blanks
 * nextHopProtocol for a cross-origin answer without Timing-Allow-Origin, and a
 * context that has not fetched from the node has no entry.
 */
export const measuredProtocol = (serverUrl: string): string | undefined => {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) {
    return undefined;
  }
  let origin: string;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return undefined;
  }
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.name.startsWith(origin)) {
      const label = protocolLabel(e.nextHopProtocol);
      if (label) {
        return label;
      }
    }
  }
  return undefined;
};
