/**
 * network logo icons as inline SVGs
 * keeps extension self-contained without external image deps
 */

import type { NetworkType } from '../state/keyring';

const iconClass = 'h-full w-full';

/** penumbra shield icon */
const PenumbraIcon = () => (
  <svg viewBox='0 0 32 32' className={iconClass}>
    <circle cx='16' cy='16' r='14' fill='#8B5CF6' />
    <path d='M16 6 L24 14 L16 26 L8 14 Z' fill='none' stroke='white' strokeWidth='1.5' strokeLinejoin='round' />
    <path d='M16 12 L20 16 L16 22 L12 16 Z' fill='white' opacity='0.6' />
  </svg>
);

/** zcash logo — stylized Z with horizontal bars */
const ZcashIcon = () => (
  <svg viewBox='0 0 32 32' className={iconClass}>
    <circle cx='16' cy='16' r='14' fill='#F4B728' />
    <g fill='white'>
      {/* top bar */}
      <rect x='10' y='9' width='12' height='1.8' rx='0.5' />
      {/* diagonal */}
      <polygon points='21,10.8 11,20.2 11,22.2 21,12.8' />
      {/* bottom bar */}
      <rect x='10' y='21.2' width='12' height='1.8' rx='0.5' />
      {/* vertical stem top */}
      <rect x='15' y='6' width='2' height='4' rx='0.5' />
      {/* vertical stem bottom */}
      <rect x='15' y='22' width='2' height='4' rx='0.5' />
    </g>
  </svg>
);

/** noble */
const NobleIcon = () => (
  <svg viewBox='0 0 32 32' className={iconClass}>
    <circle cx='16' cy='16' r='14' fill='#60A5FA' />
    <text x='16' y='21' textAnchor='middle' fill='white' fontSize='14' fontWeight='bold' fontFamily='sans-serif'>N</text>
  </svg>
);

/** cosmos hub */
const CosmosHubIcon = () => (
  <svg viewBox='0 0 32 32' className={iconClass}>
    <circle cx='16' cy='16' r='14' fill='#6366F1' />
    <text x='16' y='21' textAnchor='middle' fill='white' fontSize='13' fontWeight='bold' fontFamily='sans-serif'>ATOM</text>
  </svg>
);

/** fallback colored circle */
const FallbackIcon = ({ color }: { color: string }) => (
  <svg viewBox='0 0 32 32' className={iconClass}>
    <circle cx='16' cy='16' r='14' fill={color} />
  </svg>
);

const NETWORK_ICON_MAP: Partial<Record<NetworkType, () => JSX.Element>> = {
  penumbra: PenumbraIcon,
  zcash: ZcashIcon,
  noble: NobleIcon,
  cosmoshub: CosmosHubIcon,
};

const FALLBACK_COLORS: Record<string, string> = {
  'purple-500': '#8B5CF6',
  'yellow-500': '#EAB308',
  'pink-500': '#EC4899',
  'gray-500': '#6B7280',
  'purple-400': '#A78BFA',
  'blue-400': '#60A5FA',
  'orange-500': '#F97316',
  'purple-600': '#9333EA',
  'blue-500': '#3B82F6',
  'orange-400': '#FB923C',
};

export const NetworkIcon = ({ network, color, size = 'md' }: {
  network: NetworkType;
  color?: string;
  size?: 'sm' | 'md' | 'lg';
}) => {
  const sizeClass = size === 'sm' ? 'h-4 w-4' : size === 'lg' ? 'h-8 w-8' : 'h-5 w-5';
  const IconComponent = NETWORK_ICON_MAP[network];

  return (
    <div className={sizeClass}>
      {IconComponent ? (
        <IconComponent />
      ) : (
        <FallbackIcon color={FALLBACK_COLORS[color?.replace('bg-', '') ?? ''] ?? '#6B7280'} />
      )}
    </div>
  );
};
