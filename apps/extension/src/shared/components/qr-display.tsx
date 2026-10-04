/**
 * qr code display component
 *
 * displays a qr code for zigner to scan (sign requests, etc), plus an
 * optional title/description and a copy-hex button. Built on the one QR
 * renderer zafu draws (components/qr-code.tsx, byte mode) instead of its own
 * canvas + the `qrcode` module directly.
 */

import { useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { QrCode } from '../../components/qr-code';

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
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(data);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore copy errors
    }
  };

  return (
    <div className='flex flex-col items-center gap-3'>
      {title && <h3 className='text-lg text-fg'>{title}</h3>}

      <div className='max-w-full bg-white p-3'>
        <QrCode hex={data} size={size} label={title ?? 'qr code'} />
      </div>

      {description && <p className='text-sm text-fg-muted text-center max-w-xs'>{description}</p>}

      {showCopy && (
        <Button variant='quiet' size='sm' onClick={handleCopy} className='gap-2'>
          {copied ? (
            <>
              <span className='i-ph-check w-4 h-4 text-green-400' />
              copied
            </>
          ) : (
            <>
              <span className='i-ph-copy w-4 h-4' />
              copy hex
            </>
          )}
        </Button>
      )}
    </div>
  );
}
