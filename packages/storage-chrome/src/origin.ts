import { localExtStorage } from './local';
import { OriginRecord } from './records/known-site';
import { UserChoice } from './records/user-choice';
import {
  Capability,
  OriginPermissions,
  TIME_LIMITED_CAPABILITIES,
  GRANT_TTL_MS,
  hasCapability,
} from './capabilities';

// --- New capability-based API ---

/**
 * Drop any time-limited capability from `granted` whose grant has expired.
 * Read-only: never writes storage back (callers that mutate and save, like
 * `grantCapability`/`denyCapability`, work off `getPermissionsArray`'s
 * result, and re-pruning on every read is cheap and always correct - no
 * separate migration or write-back pass is needed).
 *
 * `hasCapability` already enforces expiry live, so this pruning is not a
 * security boundary - it exists so consumers that read `granted` directly
 * (a capability COUNT in settings, or `contact-discovery-service.ts`'s
 * "does this origin have anything granted" scan) see the same truth
 * `hasCapability` would report, instead of a stale array entry that reads as
 * "still granted" until something calls `hasCapability` on it specifically.
 */
const pruneExpiredGrants = (perms: OriginPermissions): OriginPermissions => {
  const expired = perms.granted.filter(
    cap => TIME_LIMITED_CAPABILITIES.has(cap) && !hasCapability(perms, cap),
  );
  if (expired.length === 0) {
    return perms;
  }
  return { ...perms, granted: perms.granted.filter(cap => !expired.includes(cap)) };
};

const getPermissionsArray = async (): Promise<OriginPermissions[]> => {
  const raw = await localExtStorage.get('knownSites');
  if (!Array.isArray(raw)) {
    return [];
  }
  // migrate old OriginRecord[] to OriginPermissions[] on read
  return (raw as unknown[]).map(entry => {
    const r = entry as Record<string, unknown>;
    if ('granted' in r && Array.isArray(r['granted'])) {
      return pruneExpiredGrants(r as unknown as OriginPermissions);
    }
    // legacy OriginRecord shape → convert
    const legacy = r as unknown as OriginRecord;
    const perms: OriginPermissions = {
      origin: legacy.origin,
      granted: legacy.choice === UserChoice.Approved ? ['connect'] : [],
      denied: legacy.choice === UserChoice.Denied ? ['connect'] : [],
      grantedAt: legacy.date,
    };
    return perms;
  });
};

const savePermissions = async (perms: OriginPermissions[]): Promise<void> => {
  await localExtStorage.set('knownSites', perms as unknown as OriginRecord[]);
};

export const getOriginPermissions = async (
  origin?: string,
): Promise<OriginPermissions | undefined> => {
  if (!origin) {
    return undefined;
  }
  const all = await getPermissionsArray();
  return all.find(p => p.origin === origin);
};

/**
 * grant `capability` at `origin`. Time-limited capabilities (see
 * TIME_LIMITED_CAPABILITIES) get a fresh `expires[capability]` stamped
 * GRANT_TTL_MS out from now - the TTL is a fixed constant, not a per-call
 * parameter, so every call site gets the expiry behavior automatically
 * without having to know which capabilities are time-limited.
 */
export const grantCapability = async (origin: string, capability: Capability): Promise<void> => {
  const all = await getPermissionsArray();
  const existing = all.find(p => p.origin === origin);
  const expiresAt = TIME_LIMITED_CAPABILITIES.has(capability)
    ? Date.now() + GRANT_TTL_MS
    : undefined;
  if (existing) {
    if (!existing.granted.includes(capability)) {
      existing.granted.push(capability);
    }
    existing.denied = existing.denied.filter(c => c !== capability);
    if (expiresAt !== undefined) {
      existing.expires = { ...existing.expires, [capability]: expiresAt };
    }
    await savePermissions(all);
  } else {
    await savePermissions([
      ...all,
      {
        origin,
        granted: [capability],
        denied: [],
        grantedAt: Date.now(),
        ...(expiresAt !== undefined ? { expires: { [capability]: expiresAt } } : {}),
      },
    ]);
  }
};

export const denyCapability = async (origin: string, capability: Capability): Promise<void> => {
  const all = await getPermissionsArray();
  const existing = all.find(p => p.origin === origin);
  if (existing) {
    existing.granted = existing.granted.filter(c => c !== capability);
    if (!existing.denied.includes(capability)) {
      existing.denied.push(capability);
    }
    // a denied capability should not keep carrying a stale expiry around.
    if (existing.expires && capability in existing.expires) {
      existing.expires = { ...existing.expires, [capability]: undefined };
    }
    await savePermissions(all);
  } else {
    await savePermissions([
      ...all,
      {
        origin,
        granted: [],
        denied: [capability],
        grantedAt: Date.now(),
      },
    ]);
  }
};

export const revokeOrigin = async (origin: string): Promise<void> => {
  const all = await getPermissionsArray();
  await savePermissions(all.filter(p => p.origin !== origin));
};

export const getAllPermissions = async (): Promise<OriginPermissions[]> => {
  return getPermissionsArray();
};

export const setDisplayName = async (origin: string, displayName: string): Promise<void> => {
  const all = await getPermissionsArray();
  const existing = all.find(p => p.origin === origin);
  if (existing) {
    existing.displayName = displayName || undefined;
    await savePermissions(all);
  }
};

export const setIdentity = async (origin: string, identity: string): Promise<void> => {
  const all = await getPermissionsArray();
  const existing = all.find(p => p.origin === origin);
  if (existing) {
    existing.identity = identity || undefined;
    await savePermissions(all);
  }
};

// --- Legacy API (kept for backward compat during migration) ---

export const getOriginRecord = async (getOrigin?: string): Promise<OriginRecord | undefined> => {
  if (!getOrigin) {
    return undefined;
  }
  const perms = await getOriginPermissions(getOrigin);
  if (!perms) {
    return undefined;
  }
  // map OriginPermissions → OriginRecord for legacy callers
  let choice: UserChoice;
  if (perms.granted.includes('connect')) {
    choice = UserChoice.Approved;
  } else if (perms.denied.includes('connect')) {
    choice = UserChoice.Denied;
  } else {
    choice = UserChoice.Ignored;
  }
  return { origin: perms.origin, choice, date: perms.grantedAt };
};

export const upsertOriginRecord = async (proposal: OriginRecord): Promise<void> => {
  if (proposal.choice === UserChoice.Approved) {
    await grantCapability(proposal.origin, 'connect');
  } else if (proposal.choice === UserChoice.Denied) {
    await denyCapability(proposal.origin, 'connect');
  } else {
    // Ignored — remove connect from both granted and denied
    const all = await getPermissionsArray();
    const existing = all.find(p => p.origin === proposal.origin);
    if (existing) {
      existing.granted = existing.granted.filter(c => c !== 'connect');
      existing.denied = existing.denied.filter(c => c !== 'connect');
      await savePermissions(all);
    } else {
      await savePermissions([
        ...all,
        {
          origin: proposal.origin,
          granted: [],
          denied: [],
          grantedAt: proposal.date,
        },
      ]);
    }
  }
};

export const removeOriginRecord = async (removeOrigin: string): Promise<void> => {
  await revokeOrigin(removeOrigin);
};
