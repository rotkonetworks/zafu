/**
 * qr code display component
 *
 * displays a qr code for zigner to scan (sign requests, etc)
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { CopyIcon, CheckIcon } from '@radix-ui/react-icons';

// dynamic import for qrcode since types may not be available
// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCode = require('qrcode');

interface QrDisplayProps {
  /** hex data to encode */
  data: string;
  /** size of qr code in pixels */
  size?: number;
  /** title above qr code */
  title?: string;
  /** description below qr code */
  description?: string;
  /** show copy button */
  showCopy?: boolean;
}

export function QrDisplay({
  data,
  size = 256,
  title,
  description,
  showCopy = false,
}: QrDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current || !data) return;

    // Convert hex string to binary bytes for more efficient QR encoding.
    // Binary mode fits ~2900 bytes per QR vs ~1800 for alphanumeric text.
    const bytes = new Uint8Array(data.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(data.substring(i * 2, i * 2 + 2), 16);
    }

    // qrcode library needs Buffer for byte mode in some builds
    const bufData = typeof Buffer !== 'undefined'
      ? Buffer.from(bytes)
      : bytes;

    console.log(`[qr-display] payload: ${bytes.length} bytes, hex: ${data.length} chars`);

    QRCode.toCanvas(
      canvasRef.current,
      [{ data: bufData, mode: 'byte' }],
      {
        width: size,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
        errorCorrectionLevel: 'L',
      },
      (err: Error | null) => {
        if (err) {
          setError('failed to generate qr code');
          console.error('qr generation error:', err);
        } else {
          console.log(`[qr-display] QR generated successfully at ${size}px`);
        }
      }
    );
  }, [data, size]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(data);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore copy errors
    }
  };

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 p-4">
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {title && (
        <h3 className="text-lg font-semibold text-foreground">{title}</h3>
      )}

      <div className="bg-white p-3 rounded-lg">
        <canvas ref={canvasRef} />
      </div>

      {description && (
        <p className="text-sm text-muted-foreground text-center max-w-xs">
          {description}
        </p>
      )}

      {showCopy && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="gap-2"
        >
          {copied ? (
            <>
              <CheckIcon className="w-4 h-4 text-green-500" />
              copied
            </>
          ) : (
            <>
              <CopyIcon className="w-4 h-4" />
              copy hex
            </>
          )}
        </Button>
      )}
    </div>
  );
}
