/** zapp - a zafu app/integration */
export interface Zapp {
  id: string;
  name: string;
  description: string;
  icon: string;         // lucide icon class name
  url: string;          // external URL or chrome-extension:// for local pages
  category: ZappCategory;
  builtin?: boolean;    // cannot be removed
}

export type ZappCategory = 'finance' | 'social' | 'tools' | 'games' | 'learn';

const CATEGORY_ORDER: ZappCategory[] = ['finance', 'social', 'games', 'tools', 'learn'];

export const CATEGORY_LABELS: Record<ZappCategory, string> = {
  finance: 'finance',
  social: 'social',
  games: 'games',
  tools: 'tools',
  learn: 'learn',
};

export const categoryOrder = (a: ZappCategory, b: ZappCategory) =>
  CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b);

/** default zapps shipped with zafu */
export const DEFAULT_ZAPPS: Zapp[] = [
  {
    id: 'wallet',
    name: 'wallet',
    description: 'open side panel',
    icon: 'i-lucide-wallet',
    url: '__sidepanel__',
    category: 'finance',
    builtin: true,
  },
  {
    id: 'chat',
    name: 'chat',
    description: 'zitadel messaging',
    icon: 'i-lucide-message-circle',
    url: '__zitadel__',
    category: 'social',
    builtin: true,
  },
  {
    id: 'docs',
    name: 'docs',
    description: 'guides and specs',
    icon: 'i-lucide-book-open',
    url: '__docs__',
    category: 'tools',
    builtin: true,
  },
  {
    id: 'penumbra-dex',
    name: 'penumbra dex',
    description: 'trade shielded assets',
    icon: 'i-lucide-arrow-left-right',
    url: 'https://dex.penumbra.zone',
    category: 'finance',
  },
  {
    id: 'poker',
    name: 'poker',
    description: 'play with zcash',
    icon: 'i-lucide-spade',
    url: 'https://poker.zk.bot',
    category: 'games',
  },
  {
    id: 'zigner',
    name: 'zigner',
    description: 'airgap signing app',
    icon: 'i-lucide-smartphone',
    url: 'https://zigner.rotko.net',
    category: 'tools',
  },
  {
    id: 'source',
    name: 'source code',
    description: 'github',
    icon: 'i-lucide-code',
    url: 'https://github.com/rotkonetworks/zafu',
    category: 'tools',
  },
  // learn - zcash
  {
    id: 'learn-zcash-docs',
    name: 'zcash docs',
    description: 'protocol documentation',
    icon: 'i-lucide-book-open',
    url: 'https://zcash.readthedocs.io',
    category: 'learn',
    builtin: true,
  },
  {
    id: 'learn-ecc',
    name: 'electric coin co',
    description: 'zcash core team',
    icon: 'i-lucide-zap',
    url: 'https://electriccoin.co',
    category: 'learn',
    builtin: true,
  },
  {
    id: 'learn-zcash-forum',
    name: 'zcash community',
    description: 'community forum',
    icon: 'i-lucide-users',
    url: 'https://forum.zcashcommunity.com',
    category: 'learn',
    builtin: true,
  },
  {
    id: 'learn-zfnd',
    name: 'zcash foundation',
    description: 'grants and governance',
    icon: 'i-lucide-landmark',
    url: 'https://zfnd.org',
    category: 'learn',
    builtin: true,
  },
  // learn - penumbra
  {
    id: 'learn-antumbra',
    name: 'antumbra',
    description: 'penumbra resources hub',
    icon: 'i-lucide-globe',
    url: 'https://antumbra.net',
    category: 'learn',
    builtin: true,
  },
  {
    id: 'learn-penumbra-protocol',
    name: 'penumbra protocol',
    description: 'protocol specs',
    icon: 'i-lucide-file-text',
    url: 'https://protocol.penumbra.zone',
    category: 'learn',
    builtin: true,
  },
  {
    id: 'learn-penumbra-tokenomics',
    name: 'penumbra tokenomics',
    description: 'token economics',
    icon: 'i-lucide-coins',
    url: 'https://tokenomics.penumbra.zone',
    category: 'learn',
    builtin: true,
  },
  {
    id: 'learn-penumbra-guide',
    name: 'penumbra guide',
    description: 'getting started',
    icon: 'i-lucide-graduation-cap',
    url: 'https://guide.penumbra.zone',
    category: 'learn',
    builtin: true,
  },
  {
    id: 'learn-penumbra-blog',
    name: 'penumbra blog',
    description: 'news and updates',
    icon: 'i-lucide-rss',
    url: 'https://penumbra.zone/blog',
    category: 'learn',
    builtin: true,
  },
  // learn - general privacy
  {
    id: 'learn-zafu-docs',
    name: 'zafu docs',
    description: 'wallet guides and specs',
    icon: 'i-lucide-shield',
    url: '__docs__',
    category: 'learn',
    builtin: true,
  },
];

/** resolve special URLs to actual chrome-extension:// URLs */
export const resolveZappUrl = (url: string): string | null => {
  if (url === '__sidepanel__') return null; // handled specially
  if (url === '__zitadel__') return chrome.runtime.getURL('zitadel.html');
  if (url === '__docs__') return chrome.runtime.getURL('docs/index.html');
  return url;
};
