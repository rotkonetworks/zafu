import { base64ToUint8Array } from '@penumbrafi/types/base64';

/**
 * Base64 in 32 KiB slices. `String.fromCodePoint(...bytes)` passes every byte
 * as an argument, which overflows the call stack somewhere past ~100 KB, so a
 * large sealed vault (rooms, threads) could not be written at all.
 */
const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};

// Public, stored representation of Box
export interface BoxJson {
  nonce: string;
  cipherText: string;
}

// Represents the encrypted data
export class Box {
  constructor(
    readonly nonce: Uint8Array,
    readonly cipherText: Uint8Array,
  ) {}

  static fromJson(json: BoxJson): Box {
    return new Box(base64ToUint8Array(json.nonce), base64ToUint8Array(json.cipherText));
  }

  toJson(): BoxJson {
    return {
      nonce: uint8ArrayToBase64(this.nonce),
      cipherText: uint8ArrayToBase64(this.cipherText),
    };
  }
}
