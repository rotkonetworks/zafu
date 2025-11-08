import {
  AuthorizationData,
  TransactionPlan,
} from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import * as QRCode from 'qrcode';
import {
  encodePlanToQR,
  parseAuthorizationQR,
  validateAuthorization,
  estimateQRCodeCount,
} from './airgap-signer';

/**
 * Airgap signer authorization via QR codes (UI integration)
 *
 * This module handles the user interface flow for signing transactions
 * with an air-gapped device (like Parity Signer).
 *
 * Flow:
 * 1. Generate transaction QR code
 * 2. Show QR for user to scan with their phone
 * 3. User's phone (Parity Signer) displays transaction details
 * 4. User approves and signs on phone
 * 5. Phone displays signature QR
 * 6. Open camera to scan signature QR
 * 7. Auto-submit when scanned
 */

export interface AirgapSignerUICallbacks {
  /**
   * Show the outgoing transaction QR code
   * Should display the QR in a modal/dialog for user to scan with their phone
   *
   * @param qrDataUrl - Data URL of QR code image
   * @param size - Estimated size info
   * @returns Promise that resolves when user is ready to scan return QR
   */
  showOutgoingQR: (
    qrDataUrl: string,
    size: { bytes: number; qrCount: number },
  ) => Promise<void>;

  /**
   * Open camera to scan the return signature QR
   * Should open device camera and scan QR code
   *
   * @returns Promise that resolves with the scanned hex string
   */
  scanReturnQR: () => Promise<string>;

  /**
   * Handle errors during the flow
   */
  onError: (error: Error) => void;
}

/**
 * Default UI callbacks using browser APIs
 * Can be overridden for custom UI implementations
 */
let uiCallbacks: AirgapSignerUICallbacks | null = null;

/**
 * Set custom UI callbacks for airgap signer
 * This allows the consuming application to provide its own UI
 *
 * @param callbacks - Custom UI callback implementations
 */
export function setAirgapSignerUICallbacks(callbacks: AirgapSignerUICallbacks): void {
  uiCallbacks = callbacks;
}

/**
 * Main authorization function for airgap signer
 *
 * This is called when a transaction needs to be signed with an airgap device.
 * It handles the full flow of showing QR codes and scanning signatures.
 *
 * @param plan - The transaction plan to sign
 * @returns Promise resolving to AuthorizationData with signatures
 * @throws Error if UI callbacks not set or signing fails
 */
export async function airgapSignerAuthorize(plan: TransactionPlan): Promise<AuthorizationData> {
  if (!uiCallbacks) {
    throw new Error(
      'Airgap signer UI callbacks not configured. Call setAirgapSignerUICallbacks() first.',
    );
  }

  try {
    // 1. Encode transaction plan to hex
    const planHex = encodePlanToQR(plan);
    const planByteLength = planHex.length / 2; // Hex string: 2 chars per byte

    // 2. Generate QR code data URL
    const qrDataUrl = await QRCode.toDataURL(planHex, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 400,
    });

    // 3. Show outgoing QR to user (they scan this with their phone)
    await uiCallbacks.showOutgoingQR(qrDataUrl, {
      bytes: planByteLength,
      qrCount: estimateQRCodeCount(planByteLength),
    });

    // 4. Wait for user to scan with cold wallet and sign
    // Then scan the return QR (signature)
    const signatureHex = await uiCallbacks.scanReturnQR();

    // 5. Parse the authorization data from return QR
    const authData = parseAuthorizationQR(signatureHex);

    // 6. Validate that signatures match the plan
    validateAuthorization(plan, authData);

    // 7. Return authorization data for transaction submission
    return authData;
  } catch (error) {
    uiCallbacks.onError(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Example implementation of UI callbacks using simple browser dialogs
 * (For development/testing - production should use proper UI components)
 */
export function createSimpleBrowserUICallbacks(): AirgapSignerUICallbacks {
  return {
    async showOutgoingQR(qrDataUrl, size) {
      // Show QR in a new window or modal
      // In production, this would be a proper React component
      return new Promise<void>(resolve => {
        const msg = `
          Transaction QR Code Ready

          Size: ${size.bytes} bytes (1 QR code)

          1. Scan this QR code with your Parity Signer airgap device
          2. Review the transaction details on your phone
          3. Approve and sign the transaction
          4. Click OK when you see the signature QR on your phone
        `;

        // For now, just show an alert and log the QR
        console.log('Transaction QR Code:', qrDataUrl);
        if (confirm(msg)) {
          resolve();
        }
      });
    },

    async scanReturnQR() {
      // Open camera to scan signature QR
      // In production, this would use html5-qrcode or similar
      return new Promise<string>((resolve, reject) => {
        const hex = prompt(
          'Enter the signature hex from your airgap device (or paste QR data):',
        );
        if (hex) {
          resolve(hex.trim());
        } else {
          reject(new Error('QR scan cancelled'));
        }
      });
    },

    onError(error) {
      console.error('Airgap signer error:', error);
      alert(`Airgap signing failed: ${error.message}`);
    },
  };
}

/**
 * Helper function to set up default browser UI callbacks
 * (for development/testing)
 */
export function useBrowserUICallbacks(): void {
  setAirgapSignerUICallbacks(createSimpleBrowserUICallbacks());
}
