/**
 * display name for a directory profile.
 *
 * The public endpoint appends "-<rowid>" to UNVERIFIED usernames; verified
 * names are returned as-is, so a verified "alice-2" must stay "alice-2".
 */
import { stripUnverifiedSuffix, type ZcashMeProfile } from './api';

export const zcashMeUsername = (p: ZcashMeProfile): string =>
  p.addressVerified ? p.username : stripUnverifiedSuffix(p.username);

export const zcashMeLabel = (p: ZcashMeProfile | undefined): string | undefined =>
  p ? (p.displayName ?? zcashMeUsername(p)) : undefined;
