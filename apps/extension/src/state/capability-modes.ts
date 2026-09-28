import { localExtStorage } from '@repo/storage-chrome/local';
import type { Capability } from '@repo/storage-chrome/capabilities';
import {
  parseCapabilityMode,
  type CapabilityMode,
  type CapabilityModeMap,
} from '../utils/capability-decision';

/**
 * Read/write for the per-capability participation switch. Lives here rather
 * than inline in the worker so the popup (which renders the opt-in prompt and
 * the settings rows) and the worker (which enforces) agree on the storage key
 * and the parsing. The stored shape is exactly the v3 `capabilityModes` field:
 * absence means `unset`.
 */
const KEY = 'capabilityModes';

export const getCapabilityMode = async (capability: Capability): Promise<CapabilityMode> => {
  const modes = await localExtStorage.get(KEY);
  return parseCapabilityMode(modes?.[capability]);
};

export const getCapabilityModes = async (): Promise<CapabilityModeMap> => {
  const modes = await localExtStorage.get(KEY);
  const parsed: CapabilityModeMap = {};
  for (const [capability, raw] of Object.entries(modes ?? {})) {
    parsed[capability as Capability] = parseCapabilityMode(raw);
  }
  return parsed;
};

export const setCapabilityMode = async (
  capability: Capability,
  mode: CapabilityMode,
): Promise<void> => {
  const stored = (await localExtStorage.get(KEY)) ?? {};
  const next: Record<string, 'enabled' | 'disabled'> = { ...stored };
  // Absence IS `unset`; never persist the string, so a reset is a delete.
  if (mode === 'unset') delete next[capability];
  else next[capability] = mode;
  await localExtStorage.set(KEY, next);
};
