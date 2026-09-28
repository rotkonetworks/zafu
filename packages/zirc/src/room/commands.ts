/**
 * The IRC-shaped command line: parsing what someone typed into what the room
 * should do, and completing the token under the caret against the room's members.
 *
 * Pure on purpose - no React, no network, no crypto - so the rules can be read and
 * tested on their own. The panel renders; this decides.
 *
 * Commands are deliberately few, and each one maps to something the room already
 * does: /nick is a presence re-announce, /me is a record kind, /msg is a record
 * sealed to one member, /who is the member list the sync already returns. /frost is
 * the one that records a *fact about a wallet* rather than an instruction to a
 * participant - who a multisig is made of - and it refuses a line that looks like
 * key material, because this log is shared, archived and replayed by everyone in
 * the room.
 */

import { isFingerprint } from '../custody';

export interface Member {
  pubkey: string;
  name: string;
  /** true when this member's words arrive in the clear (no room key). */
  plain?: boolean;
}

export type ParsedLine =
  | { kind: 'send'; body: string }
  | { kind: 'action'; body: string }
  | { kind: 'dm'; to: Member; body: string }
  | { kind: 'nick'; name: string }
  | { kind: 'join'; target: string }
  | { kind: 'friend'; to: Member }
  | { kind: 'unfriend'; to: Member }
  | { kind: 'friends' }
  | { kind: 'clear' }
  | { kind: 'zafu' }
  | { kind: 'leave' }
  | { kind: 'notice'; text: string }
  | { kind: 'frost'; command: FrostCommand };

/**
 * What a group can say about a multisig in the room: show it, declare its roster,
 * check it against the artifact the ceremony printed, or start a rotation.
 *
 * A roster resolved here carries room `Member`s - the parser has no key material
 * and should not: the caller that holds the participants' keys turns this into a
 * `custody` record, which is where the log's own rules apply.
 */
export type FrostCommand =
  | { readonly op: 'show' }
  | { readonly op: 'roster'; readonly threshold: number; readonly of: readonly Member[] }
  | { readonly op: 'verify'; readonly fingerprint: string }
  | { readonly op: 'rotate' };

export const FROST_USAGE =
  '/frost <show | roster k-of-n <nick|id>... | verify <fingerprint> | rotate>';

/**
 * Words that mean someone is about to paste a secret. A room is the wrong place for
 * one, and saying so out loud is cheaper than a share that lives forever in a log
 * every participant can replay.
 */
const FROST_REFUSED = ['share', 'shares', 'key', 'keys', 'seed', 'secret', 'backup'];

/** IRC-ish nick: no spaces, no punctuation that means something in a command line. */
const NICK_RE = /^[A-Za-z0-9_\-[\]\\^{}|`]{1,24}$/;

export const isValidNick = (name: string): boolean => NICK_RE.test(name);

/** the short id a member is addressed by when their name is not unique. */
export const shortId = (pubkey: string): string => pubkey.slice(0, 8);

export interface CommandSpec {
  name: string;
  usage: string;
  help: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'help', usage: '/help', help: 'this list' },
  { name: 'nick', usage: '/nick <name>', help: 'change how your name shows' },
  { name: 'msg', usage: '/msg <nick|id> <text>', help: 'private message to a member' },
  { name: 'me', usage: '/me <action>', help: 'state an action instead of saying it' },
  {
    name: 'join',
    usage: '/join <#channel|invite>',
    help: 'move to a channel, sealed if you have its invite',
  },
  {
    name: 'add',
    usage: '/add <nick|id>',
    help: 'keep a member as a friend, past this room and this window',
  },
  { name: 'friends', usage: '/friends', help: 'who you keep' },
  { name: 'forget', usage: '/forget <nick|id>', help: 'drop a friend' },
  { name: 'clear', usage: '/clear', help: 'clear the local notices in this panel' },
  {
    name: 'zafu',
    usage: '/zafu',
    help: 'talk with your Zafu wallet identity, so it persists',
  },
  { name: 'who', usage: '/who', help: 'who is here, with the id each name resolves to' },
  {
    name: 'frost',
    usage: '/frost <show|roster|verify|rotate>',
    help: 'the multisig: who signs, at which epoch, pinned to which fingerprint',
  },
  { name: 'part', usage: '/part', help: 'leave this room' },
];

export const helpText = (): string =>
  COMMANDS.map(command => `${command.usage} — ${command.help}`).join('\n');

export const whoText = (members: readonly Member[], me: string | null, channel: string): string => {
  if (members.length === 0) {
    return `${channel}: nobody here but you`;
  }
  const listed = members
    .map(member => {
      const id = shortId(member.pubkey);
      const label = member.name && member.name !== id ? `${member.name} (${id})` : id;
      return member.pubkey === me ? `${label} (you)` : label;
    })
    .join(', ');
  return `${channel}: ${members.length} here — ${listed}`;
};

/** resolve a typed target to exactly one member, or say why it cannot. */
export const resolveMember = (
  token: string,
  members: readonly Member[],
): { ok: true; member: Member } | { ok: false; reason: string } => {
  const needle = token.trim().toLowerCase();
  if (needle.length === 0) {
    return { ok: false, reason: 'who? /msg needs a nick or an id' };
  }

  const describe = (candidates: readonly Member[]) =>
    candidates.map(m => `${m.name || shortId(m.pubkey)} (${shortId(m.pubkey)})`).join(', ');

  const exact = members.filter(m => m.name.toLowerCase() === needle);
  if (exact.length === 1) {
    return { ok: true, member: exact[0]! };
  }
  if (exact.length > 1) {
    return { ok: false, reason: `two members answer to ${needle}: ${describe(exact)}` };
  }

  const byName = members.filter(m => m.name.toLowerCase().startsWith(needle));
  if (byName.length === 1) {
    return { ok: true, member: byName[0]! };
  }
  if (byName.length > 1) {
    return { ok: false, reason: `${needle} is ambiguous: ${describe(byName)} — use an id` };
  }

  // ids are hex, so a prefix is enough - and it is what a name collision falls
  // back to.
  const byId = members.filter(m => m.pubkey.toLowerCase().startsWith(needle));
  if (byId.length === 1) {
    return { ok: true, member: byId[0]! };
  }
  if (byId.length > 1) {
    return { ok: false, reason: `${needle} matches ${byId.length} ids: ${describe(byId)}` };
  }

  return { ok: false, reason: `no member matching ${needle} — /who lists them` };
};

/**
 * Parse one typed line. Anything without a leading slash is a message; a leading
 * slash is a command, and an unknown or malformed one answers with a notice
 * rather than silently going out as text.
 */
export const parseLine = (
  raw: string,
  members: readonly Member[],
  channel = '#penumbra',
  me: string | null = null,
): ParsedLine => {
  const line = raw.trim();
  if (line.length === 0) {
    return { kind: 'notice', text: 'nothing to send' };
  }
  if (!line.startsWith('/')) {
    return { kind: 'send', body: line };
  }

  const space = line.indexOf(' ');
  const command = (space === -1 ? line.slice(1) : line.slice(1, space)).toLowerCase();
  const rest = (space === -1 ? '' : line.slice(space + 1)).trim();

  switch (command) {
    case 'help':
      return { kind: 'notice', text: helpText() };

    case 'nick': {
      if (!isValidNick(rest)) {
        return {
          kind: 'notice',
          text: 'a nick is 1-24 characters, no spaces: letters, digits, _ - [ ] \\ ^ { } | `',
        };
      }
      return { kind: 'nick', name: rest };
    }

    case 'msg': {
      const split = rest.indexOf(' ');
      const target = split === -1 ? rest : rest.slice(0, split);
      const body = split === -1 ? '' : rest.slice(split + 1).trim();
      if (target.length === 0) {
        return { kind: 'notice', text: 'usage: /msg <nick|id> <text>' };
      }
      if (body.length === 0) {
        return { kind: 'notice', text: 'a direct message needs something in it' };
      }
      const resolved = resolveMember(target, members);
      if (!resolved.ok) {
        return { kind: 'notice', text: resolved.reason };
      }
      return { kind: 'dm', to: resolved.member, body };
    }

    case 'me':
      if (rest.length === 0) {
        return { kind: 'notice', text: 'usage: /me <action>' };
      }
      return { kind: 'action', body: rest };

    case 'who':
      return { kind: 'notice', text: whoText(members, me, channel) };

    case 'join':
      if (rest.startsWith('#') && rest.length > 1 && !rest.includes(' ')) {
        return { kind: 'join', target: rest };
      }
      if (rest.startsWith('zroom1:') || rest.startsWith('zroom2:')) {
        return { kind: 'join', target: rest };
      }
      return {
        kind: 'notice',
        text: 'usage: /join #channel (open lane) or /join zroom2:… (an invite, sealed)',
      };

    case 'add':
    case 'forget':
    case 'friend': {
      const resolved = resolveMember(rest, members);
      if (rest.length === 0) {
        return { kind: 'notice', text: `usage: /${command} <nick|id>` };
      }
      if (!resolved.ok) {
        return { kind: 'notice', text: resolved.reason };
      }
      return command === 'forget'
        ? { kind: 'unfriend', to: resolved.member }
        : { kind: 'friend', to: resolved.member };
    }

    case 'frost': {
      if (rest.length === 0) {
        return { kind: 'notice', text: `usage: ${FROST_USAGE}` };
      }
      const split = rest.indexOf(' ');
      const verb = (split === -1 ? rest : rest.slice(0, split)).toLowerCase();
      const args = (split === -1 ? '' : rest.slice(split + 1)).trim();

      if (FROST_REFUSED.includes(verb)) {
        return {
          kind: 'notice',
          text: `no ${verb} material in a room: this log is shared, archived and replayed by everyone in it. Keep your share where you keep your wallet.`,
        };
      }

      switch (verb) {
        case 'show':
          if (args.length > 0) {
            return { kind: 'notice', text: 'usage: /frost show' };
          }
          return { kind: 'frost', command: { op: 'show' } };

        case 'rotate':
          if (args.length > 0) {
            return { kind: 'notice', text: 'usage: /frost rotate' };
          }
          return { kind: 'frost', command: { op: 'rotate' } };

        case 'verify': {
          const fingerprint = args.toLowerCase();
          if (!isFingerprint(fingerprint)) {
            return {
              kind: 'notice',
              text: 'usage: /frost verify <fingerprint> — 8-128 lowercase letters or digits, as the ceremony printed it',
            };
          }
          return { kind: 'frost', command: { op: 'verify', fingerprint } };
        }

        case 'roster': {
          const shape = args.split(' ')[0] ?? '';
          const match = /^(\d+)(?:-of-|\/)(\d+)$/.exec(shape);
          if (!match) {
            return { kind: 'notice', text: `usage: ${FROST_USAGE}` };
          }
          const threshold = Number(match[1]);
          const total = Number(match[2]);
          if (threshold < 1 || threshold > total) {
            return {
              kind: 'notice',
              text: `a threshold of ${threshold} is not between 1 and ${total}`,
            };
          }
          const tokens = args
            .slice(shape.length)
            .trim()
            .split(/\s+/)
            .filter(token => token.length > 0);
          if (tokens.length !== total) {
            return {
              kind: 'notice',
              text: `a roster of ${shape} needs ${total} names — ${tokens.length} given`,
            };
          }
          const of: Member[] = [];
          for (const token of tokens) {
            const resolved = resolveMember(token, members);
            if (!resolved.ok) {
              return { kind: 'notice', text: resolved.reason };
            }
            if (of.some(member => member.pubkey === resolved.member.pubkey)) {
              return {
                kind: 'notice',
                text: `${resolved.member.name || shortId(resolved.member.pubkey)} is listed twice`,
              };
            }
            of.push(resolved.member);
          }
          return { kind: 'frost', command: { op: 'roster', threshold, of } };
        }

        default:
          return { kind: 'notice', text: `unknown /frost ${verb} — ${FROST_USAGE}` };
      }
    }

    case 'friends':
      return { kind: 'friends' };

    case 'clear':
      return { kind: 'clear' };

    case 'zafu':
      return { kind: 'zafu' };

    case 'part':
    case 'leave':
    case 'quit':
      return { kind: 'leave' };

    default:
      return { kind: 'notice', text: `unknown command /${command} — /help lists them` };
  }
};

/** commands whose first argument is a member, and so completes against one. */
const MEMBER_ARG_COMMANDS = ['msg', 'add', 'forget', 'friend'];

export interface Candidate {
  kind: 'command' | 'member';
  label: string;
  detail: string;
  /** what replaces [from, to) when the candidate is accepted. */
  insert: string;
}

export interface Completion {
  candidates: Candidate[];
  /** the range of the line the candidates replace. */
  from: number;
  to: number;
}

/**
 * Turn the members matching a fragment into completion candidates. Shared by the
 * command whose first argument is a member and by `/frost roster`, because the two
 * differ only in *which* members match, not in how one is offered: when a name is
 * not unique the id is what gets inserted, since an id resolves unambiguously (see
 * {@link resolveMember}).
 */
const memberCandidates = (
  fragment: string,
  from: number,
  matching: readonly Member[],
  members: readonly Member[],
): Completion | null => {
  if (!matching.length) {
    return null;
  }

  const nameCounts = new Map<string, number>();
  for (const member of members) {
    const key = member.name.toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  const candidates = matching.map(member => {
    const id = shortId(member.pubkey);
    const uniqueName = member.name.length > 0 && nameCounts.get(member.name.toLowerCase()) === 1;
    return {
      kind: 'member' as const,
      label: member.name || id,
      detail: id,
      insert: uniqueName ? member.name : id,
    };
  });
  return { candidates, from, to: from + fragment.length };
};

/**
 * Complete the token under the caret, IRC-client style: commands after a bare
 * slash, members in the first argument of /msg. Members are matched by name and
 * by id prefix; when a name is not unique the *id* is what gets inserted, because
 * an id is what resolves unambiguously (see {@link resolveMember}).
 *
 * `/frost roster` completes its member list too, which is the argument where a
 * typo is expensive: a roster has to name the exact identities the ceremony used,
 * and it does not offer anyone the line already lists.
 *
 * Returns null when there is nothing to offer, so a caller can leave the caret
 * alone rather than pop an empty list.
 */
export const complete = (
  line: string,
  caret: number,
  members: readonly Member[],
): Completion | null => {
  const prefix = line.slice(0, Math.max(0, Math.min(caret, line.length)));
  if (!prefix.startsWith('/')) {
    return null;
  }

  const space = prefix.indexOf(' ');
  if (space === -1) {
    const fragment = prefix.slice(1).toLowerCase();
    const candidates = COMMANDS.filter(c => c.name.startsWith(fragment)).map(c => ({
      kind: 'command' as const,
      label: `/${c.name}`,
      detail: c.usage.slice(c.name.length + 2) || c.help,
      // a command that takes arguments is completed with a space, so the caret
      // lands where the argument goes.
      insert: c.usage.includes(' ') ? `${c.name} ` : c.name,
    }));
    return candidates.length ? { candidates, from: 1, to: prefix.length } : null;
  }

  const command = prefix.slice(1, space).toLowerCase();
  const argStart = space + 1;
  const words = prefix
    .slice(argStart)
    .split(/\s+/)
    .filter(word => word.length > 0);

  if (command === 'frost') {
    // /frost roster <k-of-n> <nick|id>... - after the shape, every token is a
    // member. Nothing is offered until the shape is a complete k-of-n.
    if (words[0]?.toLowerCase() !== 'roster' || !/^\d+(?:-of-|\/)\d+$/.test(words[1] ?? '')) {
      return null;
    }
    const fragment = prefix.endsWith(' ') ? '' : (words[words.length - 1] ?? '').toLowerCase();
    const from = prefix.length - fragment.length;
    const listed = (prefix.endsWith(' ') ? words.slice(2) : words.slice(2, -1)).map(word =>
      word.toLowerCase(),
    );
    const matching = members.filter(
      member =>
        !listed.some(
          token => token === member.pubkey.toLowerCase() || token === member.name.toLowerCase(),
        ) &&
        (member.name.toLowerCase().startsWith(fragment) ||
          member.pubkey.toLowerCase().startsWith(fragment)),
    );
    return memberCandidates(fragment, from, matching, members);
  }

  if (!MEMBER_ARG_COMMANDS.includes(command)) {
    return null;
  }
  // only the first argument is a target; once it is complete, stop offering.
  if (prefix.slice(argStart).includes(' ')) {
    return null;
  }

  const fragment = prefix.slice(argStart).toLowerCase();
  const matching = members.filter(
    m => m.name.toLowerCase().startsWith(fragment) || m.pubkey.toLowerCase().startsWith(fragment),
  );
  return memberCandidates(fragment, argStart, matching, members);
};
