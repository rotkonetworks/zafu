/**
 * The one QR code zafu draws: ink dots on warm paper, rounded finder squares,
 * the zafu mark in the middle.
 *
 * Built from the `qrcode` module matrix and rendered as SVG, so it is sharp
 * at any size and styled like the rest of the wallet instead of a stock
 * black-on-white bitmap. Error correction is level H (30%), which leaves room
 * for the centre logo without hurting scanning; modules under the logo are
 * skipped. Dark-on-light on purpose: many scanners can't read inverted codes.
 */

import { useMemo } from 'react';
import QRCode from 'qrcode';

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

interface QrCodeProps {
  value: string;
  /** rendered width/height in px; grows for dense codes so they stay scannable */
  size?: number;
  className?: string;
  /** accessible label, e.g. "Injective address QR" */
  label: string;
}

export const QrCode = ({ value, size = 176, className, label }: QrCodeProps) => {
  const { count, dots, logoCells } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'H' });
    const n = qr.modules.size;
    const logo = Math.ceil(n * LOGO_FRACTION) | 1; // odd, so it centres on a module
    const lo = (n - logo) / 2;
    const inFinder = (r: number, c: number) =>
      (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
    const inLogo = (r: number, c: number) => r >= lo && r < lo + logo && c >= lo && c < lo + logo;
    const cells: [number, number][] = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.modules.get(r, c) && !inFinder(r, c) && !inLogo(r, c)) {
          cells.push([r, c]);
        }
      }
    }
    return { count: n, dots: cells, logoCells: { start: lo, size: logo } };
  }, [value]);

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
          <circle key={`${r}-${c}`} cx={c + 0.5} cy={r + 0.5} r={0.42} />
        ))}
        {finders.map(([r, c]) => (
          <g key={`f-${r}-${c}`}>
            <rect
              x={c + 0.5}
              y={r + 0.5}
              width={6}
              height={6}
              rx={1.6}
              fill='none'
              stroke={INK}
              strokeWidth={1}
            />
            <rect x={c + 2} y={r + 2} width={3} height={3} rx={0.8} />
          </g>
        ))}
        <rect
          x={logoCells.start}
          y={logoCells.start}
          width={logoCells.size}
          height={logoCells.size}
          rx={1}
          fill={PAPER}
        />
        <image
          href={chrome.runtime.getURL('favicon/icon128.png')}
          x={logoCells.start + 0.6}
          y={logoCells.start + 0.6}
          width={logoCells.size - 1.2}
          height={logoCells.size - 1.2}
        />
      </g>
    </svg>
  );
};
