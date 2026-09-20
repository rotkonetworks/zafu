/** zapp - a zafu app/integration */
export interface Zapp {
  id: string;
  name: string;
  description: string;
  icon: string; // lucide icon class name
  url: string; // external URL or chrome-extension:// for local pages
  category: ZappCategory;
  builtin?: boolean; // cannot be removed
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
    icon: 'i-ph-wallet',
    url: '__sidepanel__',
    category: 'finance',
    builtin: true,
  },
  {
    id: 'zitadel',
    name: 'zitadel',
    description: 'zafu chat - support & community',
    icon: 'i-ph-chat-circle',
    // packaged in-extension chat over the zafu relay (zrelay.rotko.net).
    // resolves to zitadel.html via resolveZappUrl('__zitadel__').
    url: '__zitadel__',
    category: 'social',
    builtin: true,
  },
  {
    id: 'discord-zcash',
    name: 'zcash discord',
    description: 'zcash community',
    icon: 'i-ph-discord-logo',
    url: 'https://discord.gg/zcash',
    category: 'social',
    builtin: true,
  },
  {
    id: 'discord-penumbra',
    name: 'penumbra discord',
    description: 'penumbra community',
    icon: 'i-ph-discord-logo',
    url: 'https://discord.gg/hKvkrqa3zC',
    category: 'social',
    builtin: true,
  },
  {
    id: 'docs',
    name: 'docs',
    description: 'guides and specs',
    icon: 'i-ph-book-open',
    url: '__docs__',
    category: 'tools',
    builtin: true,
  },
  {
    id: 'penumbra-dex',
    name: 'penumbra dex',
    description: 'trade shielded assets on penumbra',
    icon: 'i-ph-arrows-left-right',
    url: 'https://penumbra.fi',
    category: 'finance',
    builtin: true,
  },
  {
    id: 'zec-os',
    name: 'zec-os',
    description: 'zcash defi',
    icon: 'i-ph-coins',
    url: 'https://zec-os.com',
    category: 'finance',
    builtin: true,
  },
  {
    id: 'poker',
    name: 'poker',
    description: 'play with zcash',
    icon: 'i-ph-spade',
    url: 'https://zkbtc.org',
    category: 'games',
    builtin: true,
  },
  {
    id: 'sonotxt',
    name: 'sonotxt',
    description: 'private text-to-speech',
    icon: 'i-ph-waveform',
    url: 'https://sonotxt.com',
    category: 'tools',
    builtin: true,
  },
  {
    id: 'zigner',
    name: 'zigner',
    description: 'airgap signing app',
    icon: 'i-ph-device-mobile',
    url: 'https://zafu.pro/zigner',
    category: 'tools',
    builtin: true,
  },
  {
    id: 'source',
    name: 'source code',
    description: 'github',
    icon: 'i-ph-code',
    url: 'https://github.com/rotkonetworks/zafu',
    category: 'tools',
    builtin: true,
  },
  // learn - zcash
  {
    id: 'learn-zcash-docs',
    name: 'zcash docs',
    description: 'protocol documentation',
    icon: 'i-ph-book-open',
    url: 'https://zcash.readthedocs.io',
    category: 'learn',
    builtin: true,
  },
  {
    id: 'learn-ecc',
    name: 'electric coin co',
    description: 'zcash core team',
    icon: 'i-ph-lightning',
    url: 'https://electriccoin.co',
    category: 'learn',
    builtin: true,
  },
  {
    id: 'learn-zcash-forum',
    name: 'zcash community',
    description: 'community forum',
    icon: 'i-ph-users',
    url: 'https://forum.zcashcommunity.com',
    category: 'learn',
    builtin: true,
  },
  {
    id: 'learn-zfnd',
    name: 'zcash foundation',
    description: 'grants and governance',
    icon: 'i-ph-bank',
    url: 'https://zfnd.org',
    category: 'learn',
    builtin: true,
  },
  {
    id: 'learn-zechub',
    name: 'zechub',
    description: 'zcash education hub',
    icon: 'i-ph-graduation-cap',
    url: 'https://zechub.wiki',
    category: 'learn',
    builtin: true,
  },
  // learn - penumbra
  {
    id: 'learn-penumbra-protocol',
    name: 'penumbra protocol',
    description: 'protocol specs',
    icon: 'i-ph-file-text',
    url: 'https://protocol.penumbra.zone',
    category: 'learn',
    builtin: true,
  },
  {
    id: 'learn-penumbra-guide',
    name: 'penumbra guide',
    description: 'getting started',
    icon: 'i-ph-graduation-cap',
    url: 'https://guide.penumbra.zone',
    category: 'learn',
    builtin: true,
  },
  {
    id: 'learn-penumbra-blog',
    name: 'penumbra blog',
    description: 'news and updates',
    icon: 'i-ph-rss',
    url: 'https://penumbra.zone/blog',
    category: 'learn',
    builtin: true,
  },
  // learn - general privacy
  {
    id: 'learn-zafu-docs',
    name: 'zafu docs',
    description: 'wallet guides and specs',
    icon: 'i-ph-shield',
    url: '__docs__',
    category: 'learn',
    builtin: true,
  },
];

/**
 * Community Discord servers the packaged `chat` zapp points at, chosen by the
 * active network.
 *
 * Both invites were verified live 2026-09-21 against Discord's own endpoint
 * (`GET https://discord.com/api/v10/invites/<code>`): zcash -> guild "Zcash",
 * penumbra -> guild "Penumbra", neither expiring. The tile previously pointed
 * at `discord.gg/penumbra`, which answers "Unknown Invite" (code 10006) - a
 * dead invite sends users to nowhere. Re-check with that endpoint before
 * changing either string.
 */
export const DISCORD_BY_NETWORK: Record<string, string> = {
  zcash: 'https://discord.gg/zcash',
  penumbra: 'https://discord.gg/hKvkrqa3zC',
};

/** Fall back to the Zcash server when the network has no mapping. */
export const resolveDiscordUrl = (network: string | undefined): string =>
  (network && DISCORD_BY_NETWORK[network]) || DISCORD_BY_NETWORK['zcash']!;

/** resolve special URLs to actual chrome-extension:// URLs */
export const resolveZappUrl = (url: string): string | null => {
  if (url === '__sidepanel__' || url === '__discord__') {
    return null;
  } // handled specially in the click handler (need active network / side panel)
  if (url === '__zitadel__') {
    return chrome.runtime.getURL('zitadel.html');
  }
  if (url === '__docs__') {
    return chrome.runtime.getURL('docs/index.html');
  }
  return url;
};
