/**
 * ZIP 302: a memo whose first byte is 0xF4 or below is UTF-8 text, padded
 * with zeros. The wasm decoder also asks that most bytes be printable ASCII,
 * and counts no UTF-8 continuation byte, so a memo with a few accents or any
 * CJK read as binary and never reached the inbox. This reads it as the text
 * it is; anything else (0xF5 to 0xFF, invalid UTF-8) stays as wasm left it.
 */
export const zip302Text = (memoHex: string): string | undefined => {
  if (!/^[0-9a-f]{1024}$/i.test(memoHex)) {
    return undefined;
  }
  const bytes = Uint8Array.from(memoHex.match(/../g)!, h => parseInt(h, 16));
  if (bytes[0]! > 0xf4) {
    return undefined;
  }
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) {
    end--;
  }
  if (end === 0) {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
  } catch {
    return undefined;
  }
};

/** the decrypted memos, with any ZIP 302 text the wasm decoder missed read as text */
export const withMemoText = <M extends { memo: string; memo_is_text: boolean; memo_bytes: string }>(
  memos: M[],
): M[] =>
  memos.map(m => {
    const text = m.memo_is_text ? undefined : zip302Text(m.memo_bytes);
    return text === undefined ? m : { ...m, memo: text, memo_is_text: true };
  });
