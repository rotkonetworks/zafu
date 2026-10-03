/**
 * The one QR code zafu draws: square ink modules on warm paper, square
 * finder patterns, the zafu mark in the middle.
 *
 * Built from the `qrcode` module matrix and rendered as SVG, so it is sharp
 * at any size and styled like the rest of the wallet instead of a stock
 * black-on-white bitmap. Error correction defaults to level H (30%), which
 * leaves room for the centre logo without hurting scanning; modules under the
 * logo are skipped. Dark-on-light on purpose: many scanners can't read
 * inverted codes.
 *
 * `hex` encodes raw bytes (zigner's binary QR payloads - sign requests, PCZTs)
 * in byte mode instead of text mode; those are large, so they default to
 * level L for capacity and skip the logo (L's 7% tolerance leaves no safe
 * room for one).
 */

import { useMemo } from 'react';
import QRCode, { type QRCodeErrorCorrectionLevel } from 'qrcode';

const PAPER = '#f4efe4';
const INK = '#1c1916';
/** the logo covers this fraction of the code's width (well under H's 30%) */
const LOGO_FRACTION = 0.22;
/**
 * Minimum rendered pixels per module. Below ~3 a long code (a zcash unified
 * address is ~77 modules at level H) stops decoding - verified with zxing on
 * headless-chromium screenshots: 176px failed, 240px decoded.
 */
const MIN_PX_PER_MODULE = 3;

const hexToBytes = (hex: string): Buffer | Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  // some qrcode builds need a real Buffer for byte-mode segments
  return typeof Buffer !== 'undefined' ? Buffer.from(bytes) : bytes;
};

interface QrCodeProps {
  /** text to encode (an address, a link, ...). Exactly one of `value`/`hex`. */
  value?: string;
  /** raw payload, as hex, encoded in QR byte mode (zigner). Exactly one of `value`/`hex`. */
  hex?: string;
  /** rendered width/height in px; grows for dense codes so they stay scannable */
  size?: number;
  className?: string;
  /** accessible label, e.g. "Injective address QR" */
  label: string;
  /** @default hex ? 'L' : 'H' */
  ecLevel?: QRCodeErrorCorrectionLevel;
}

export const QrCode = ({ value, hex, size = 176, className, label, ecLevel }: QrCodeProps) => {
  const level = ecLevel ?? (hex ? 'L' : 'H');
  // a low-tolerance byte payload has no safe room for the centre logo
  const showLogo = level === 'H';

  const { count, dots, logoCells } = useMemo(() => {
    const qr = hex
      ? QRCode.create([{ data: hexToBytes(hex), mode: 'byte' }], { errorCorrectionLevel: level })
      : QRCode.create(value ?? '', { errorCorrectionLevel: level });
    const n = qr.modules.size;
    const logo = Math.ceil(n * LOGO_FRACTION) | 1; // odd, so it centres on a module
    const lo = (n - logo) / 2;
    const inFinder = (r: number, c: number) =>
      (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
    const inLogo = (r: number, c: number) =>
      showLogo && r >= lo && r < lo + logo && c >= lo && c < lo + logo;
    const cells: [number, number][] = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.modules.get(r, c) && !inFinder(r, c) && !inLogo(r, c)) {
          cells.push([r, c]);
        }
      }
    }
    return { count: n, dots: cells, logoCells: { start: lo, size: logo } };
  }, [value, hex, level, showLogo]);

  const quiet = 2; // quiet zone, in modules
  const view = count + quiet * 2;
  const px = Math.max(size, view * MIN_PX_PER_MODULE);
  const finders: [number, number][] = [
    [0, 0],
    [0, count - 7],
    [count - 7, 0],
  ];

  return (
    <svg
      viewBox={`0 0 ${view} ${view}`}
      width={px}
      height={px}
      className={className}
      role='img'
      aria-label={label}
    >
      <rect width={view} height={view} fill={PAPER} />
      <g transform={`translate(${quiet} ${quiet})`} fill={INK}>
        {dots.map(([r, c]) => (
          <rect key={`${r}-${c}`} x={c} y={r} width={1} height={1} />
        ))}
        {finders.map(([r, c]) => (
          <g key={`f-${r}-${c}`}>
            <rect
              x={c + 0.5}
              y={r + 0.5}
              width={6}
              height={6}
              fill='none'
              stroke={INK}
              strokeWidth={1}
            />
            <rect x={c + 2} y={r + 2} width={3} height={3} />
          </g>
        ))}
        {showLogo && (
          <>
            <rect
              x={logoCells.start}
              y={logoCells.start}
              width={logoCells.size}
              height={logoCells.size}
              fill={PAPER}
            />
            <image
              href={chrome.runtime.getURL('favicon/icon128.png')}
              x={logoCells.start + 0.6}
              y={logoCells.start + 0.6}
              width={logoCells.size - 1.2}
              height={logoCells.size - 1.2}
            />
          </>
        )}
      </g>
    </svg>
  );
};
