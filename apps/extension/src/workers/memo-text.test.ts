import { describe, expect, it } from 'vitest';
import { withMemoText, zip302Text } from './memo-text';

const memoHex = (bytes: Uint8Array | number[]) => {
  const m = new Uint8Array(512);
  m.set(bytes);
  return Array.from(m, b => b.toString(16).padStart(2, '0')).join('');
};
const utf8 = (s: string) => new TextEncoder().encode(s);

describe('zip 302 memo text', () => {
  it('reads text that is mostly non-ascii, which the wasm decoder dropped', () => {
    const text = 'qa 匿 名 mv8cq34n · ünï';
    expect(zip302Text(memoHex(utf8(text)))).toBe(text);
    expect(zip302Text(memoHex(utf8('匿名の手紙')))).toBe('匿名の手紙');
  });

  it('leaves no-memo, binary and structured memos alone', () => {
    expect(zip302Text(memoHex([0xf6]))).toBeUndefined();
    expect(zip302Text(memoHex([0xff, 0x5a, 1, 2]))).toBeUndefined();
    expect(zip302Text(memoHex([]))).toBeUndefined();
    // not valid utf-8
    expect(zip302Text(memoHex([0x61, 0xc3, 0x28]))).toBeUndefined();
  });

  it('only fills in what wasm missed', () => {
    const hex = memoHex(utf8('ünï 匿'));
    const [missed, kept] = withMemoText([
      { memo: hex, memo_is_text: false, memo_bytes: hex },
      { memo: 'hello', memo_is_text: true, memo_bytes: memoHex(utf8('hello')) },
    ]);
    expect(missed).toMatchObject({ memo: 'ünï 匿', memo_is_text: true });
    expect(kept!.memo).toBe('hello');
  });
});
