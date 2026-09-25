import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  complete,
  isValidNick,
  parseLine,
  resolveMember,
  shortId,
  whoText,
  type Member,
} from './commands';

const alice: Member = { pubkey: 'a1'.repeat(32), name: 'alice' };
const bob: Member = { pubkey: 'b2'.repeat(32), name: 'bob' };
const bobToo: Member = { pubkey: 'b2ff'.padEnd(64, '0'), name: 'bob' };
const carol: Member = { pubkey: 'c3'.repeat(32), name: '' };
const members = [alice, bob, carol];

describe('parseLine', () => {
  it('treats a line without a slash as a message', () => {
    expect(parseLine('gm everyone', members)).toEqual({ kind: 'send', body: 'gm everyone' });
    expect(parseLine('  padded  ', members)).toEqual({ kind: 'send', body: 'padded' });
  });

  it('never lets an empty line become a message', () => {
    expect(parseLine('   ', members)).toEqual({ kind: 'notice', text: 'nothing to send' });
  });

  it('renames on /nick, and refuses a nick a command line cannot carry', () => {
    expect(parseLine('/nick jorma', members)).toEqual({ kind: 'nick', name: 'jorma' });
    expect(parseLine('/NICK Jorma', members)).toEqual({ kind: 'nick', name: 'Jorma' });
    expect(parseLine('/nick', members)).toMatchObject({ kind: 'notice' });
    expect(parseLine('/nick two words', members)).toMatchObject({ kind: 'notice' });
    expect(isValidNick('ok-[1]_name')).toBe(true);
    expect(isValidNick('with space')).toBe(false);
    expect(isValidNick('x'.repeat(25))).toBe(false);
  });

  it('resolves /msg by nick, by nick prefix, and by id - and says when it cannot', () => {
    expect(parseLine('/msg alice hello there', members)).toEqual({
      kind: 'dm',
      to: alice,
      body: 'hello there',
    });
    expect(parseLine('/msg ALI hey', members)).toEqual({ kind: 'dm', to: alice, body: 'hey' });
    expect(parseLine(`/msg ${shortId(bob.pubkey)} direct`, members)).toEqual({
      kind: 'dm',
      to: bob,
      body: 'direct',
    });

    // a name two members answer to is an error, not a coin flip
    const ambiguous = parseLine('/msg bob hi', members.concat(bobToo));
    expect(ambiguous).toMatchObject({ kind: 'notice' });
    expect((ambiguous as { text: string }).text).toMatch(/two members answer to bob/);
    expect((ambiguous as { text: string }).text).toContain(shortId(bobToo.pubkey));

    expect(parseLine('/msg nobody hi', members)).toMatchObject({ kind: 'notice' });
    expect(parseLine('/msg', members)).toMatchObject({ kind: 'notice', text: /usage/ });
    expect(parseLine('/msg alice', members)).toMatchObject({
      kind: 'notice',
      text: /needs something/,
    });
  });

  it('joins a channel or a room, and refuses anything else', () => {
    expect(parseLine('/join #trading', members)).toEqual({ kind: 'join', target: '#trading' });
    expect(parseLine('/join zroom2:abc.def', members)).toEqual({
      kind: 'join',
      target: 'zroom2:abc.def',
    });
    // the first invite shape still reads: a room with no channel field
    expect(parseLine('/join zroom1:abc.def', members)).toEqual({
      kind: 'join',
      target: 'zroom1:abc.def',
    });
    expect(parseLine('/join hunter2', members)).toMatchObject({ kind: 'notice', text: /usage/ });
    expect(parseLine('/join', members)).toMatchObject({ kind: 'notice', text: /usage/ });
  });

  it('clears the local notices on /clear', () => {
    expect(parseLine('/clear', members)).toEqual({ kind: 'clear' });
  });

  it('keeps and drops a friend by the same names /msg resolves', () => {
    expect(parseLine('/add alice', members)).toEqual({ kind: 'friend', to: alice });
    expect(parseLine(`/add ${shortId(carol.pubkey)}`, members)).toEqual({
      kind: 'friend',
      to: carol,
    });
    expect(parseLine('/forget alice', members)).toEqual({ kind: 'unfriend', to: alice });
    expect(parseLine('/friends', members)).toEqual({ kind: 'friends' });
    expect(parseLine('/add', members)).toMatchObject({ kind: 'notice', text: /usage/ });
    expect(parseLine('/add nobody', members)).toMatchObject({ kind: 'notice' });
  });

  it('asks for the wallet identity on /zafu', () => {
    expect(parseLine('/zafu', members)).toEqual({ kind: 'zafu' });
  });

  it('carries /me as an action and /part as leaving', () => {
    expect(parseLine('/me waves at everyone', members)).toEqual({
      kind: 'action',
      body: 'waves at everyone',
    });
    expect(parseLine('/me', members)).toMatchObject({ kind: 'notice', text: /usage/ });
    expect(parseLine('/part', members)).toEqual({ kind: 'leave' });
  });

  it('answers /who and /help as notices, and refuses an unknown command', () => {
    const who = parseLine('/who', members);
    expect(who).toMatchObject({ kind: 'notice' });
    expect((who as { text: string }).text).toContain('#penumbra');
    expect((who as { text: string }).text).toContain(shortId(carol.pubkey));

    const help = parseLine('/help', members);
    expect((help as { text: string }).text.split('\n')).toHaveLength(COMMANDS.length);

    expect(parseLine('/nope', members)).toMatchObject({
      kind: 'notice',
      text: /unknown command \/nope/,
    });
  });

  it('names the id a bare nickname cannot', () => {
    // an unnamed member is addressable by id, which is the only handle they have
    expect(parseLine(`/msg ${shortId(carol.pubkey)} ohai`, members)).toEqual({
      kind: 'dm',
      to: carol,
      body: 'ohai',
    });
  });
});

describe('resolveMember', () => {
  it('prefers an exact name over a prefix of a longer one', () => {
    const longer: Member = { pubkey: 'd4'.repeat(32), name: 'alice2' };
    expect(resolveMember('alice', [alice, longer])).toEqual({ ok: true, member: alice });
  });

  it('refuses an empty token', () => {
    expect(resolveMember('  ', members)).toMatchObject({ ok: false });
  });
});

describe('complete', () => {
  it('offers commands after a bare slash, and completes arguments with a space', () => {
    const all = complete('/', 1, members);
    expect(all?.candidates.map(c => c.label)).toContain('/msg');
    expect(all?.candidates.map(c => c.label)).toContain('/who');

    const m = complete('/m', 2, members);
    expect(m?.candidates.map(c => c.label)).toEqual(['/msg', '/me']);
    expect(m?.from).toBe(1);
    expect(m?.to).toBe(2);
    expect(m?.candidates.find(c => c.label === '/msg')?.insert).toBe('msg ');
  });

  it('offers members in the first argument of /msg, by name and by id', () => {
    const byName = complete('/msg a', 6, members);
    expect(byName?.candidates.map(c => c.label)).toEqual(['alice']);
    expect(byName?.from).toBe(5);
    expect(byName?.to).toBe(6);
    expect(byName?.candidates[0]?.insert).toBe('alice');

    const byId = complete(`/msg ${shortId(bob.pubkey).slice(0, 2)}`, 8, members.concat(bobToo));
    expect(byId?.candidates.map(c => c.detail)).toEqual([
      shortId(bob.pubkey),
      shortId(bobToo.pubkey),
    ]);
  });

  it('completes members for every command that takes one', () => {
    for (const command of ['msg', 'add', 'forget']) {
      const result = complete(`/${command} a`, command.length + 3, members);
      // command in the value so a failure says which one
      expect({ command, labels: result?.candidates.map(c => c.label) }).toEqual({
        command,
        labels: ['alice'],
      });
    }
  });

  it('offers everyone for an empty target, and stops once the text begins', () => {
    const empty = complete('/msg ', 5, members);
    expect(empty?.candidates.map(c => c.detail)).toEqual(members.map(m => shortId(m.pubkey)));
    expect(complete('/msg alice hello', 15, members)).toBeNull();
  });

  it('inserts the id when a name is not unique', () => {
    const withTwin = complete('/msg b', 6, members.concat(bobToo));
    expect(withTwin?.candidates.map(c => c.insert)).toEqual([
      shortId(bob.pubkey),
      shortId(bobToo.pubkey),
    ]);
    expect(withTwin?.candidates.map(c => c.label)).toEqual(['bob', 'bob']);
  });

  it('offers nothing where there is nothing to complete', () => {
    expect(complete('hello', 5, members)).toBeNull();
    expect(complete('/msg zzz', 8, members)).toBeNull();
    expect(complete('/who ', 5, members)).toBeNull();
  });
});

describe('whoText', () => {
  it('marks the caller and gives every name an id', () => {
    const text = whoText(members, alice.pubkey, '#penumbra');
    expect(text).toBe(
      `#penumbra: 3 here — alice (${shortId(alice.pubkey)}) (you), bob (${shortId(bob.pubkey)}), ${shortId(carol.pubkey)}`,
    );
  });
});
