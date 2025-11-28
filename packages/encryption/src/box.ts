import { uint8ArrayToBase64, base64ToUint8Array } from '@penumbra-zone/types/base64';

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

  /**
   * Create a Box from plaintext without encryption.
   * Used for non-sensitive metadata that still needs Box format for consistency.
   * The "cipherText" is just the UTF-8 encoded plaintext.
   */
  static fromPlaintext(plaintext: string): Box {
    const encoder = new TextEncoder();
    // Use zero nonce to indicate unencrypted box
    const nonce = new Uint8Array(24);
    const data = encoder.encode(plaintext);
    return new Box(nonce, data);
  }

  /**
   * Read plaintext from an unencrypted box.
   * Returns null if the box appears to be encrypted (non-zero nonce).
   */
  toPlaintext(): string | null {
    // Check if nonce is all zeros (indicates unencrypted)
    if (!this.nonce.every(b => b === 0)) {
      return null;
    }
    const decoder = new TextDecoder();
    return decoder.decode(this.cipherText);
  }

  toJson(): BoxJson {
    return {
      nonce: uint8ArrayToBase64(this.nonce),
      cipherText: uint8ArrayToBase64(this.cipherText),
    };
  }
}
