import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Abuse limits for the sponsor.
 *
 * - The GLOBAL daily grant count is persisted, so a restart cannot reset the
 *   budget that protects the granter's balance.
 * - Per-IP counters live in memory only. Nothing that identifies a client is
 *   written to disk; a restart forgets them, which costs at most one extra
 *   day's per-IP allowance and is bounded by the global cap anyway.
 */

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

interface PersistedState {
  day: string;
  grants: number;
}

export type LimitDenial = 'daily_budget' | 'ip_daily' | 'ip_rate';

export class Limits {
  private state: PersistedState;
  private ipGrants = new Map<string, number>();
  private ipRequests = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly opts: {
      stateFile: string;
      dailyGrantCap: number;
      perIpDailyGrantCap: number;
      perIpRequestsPerHour: number;
    },
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = this.load();
  }

  private load(): PersistedState {
    try {
      const raw = JSON.parse(readFileSync(this.opts.stateFile, 'utf8')) as Partial<PersistedState>;
      if (typeof raw.day === 'string' && typeof raw.grants === 'number') {
        return { day: raw.day, grants: raw.grants };
      }
    } catch {
      // missing or unreadable: start fresh
    }
    return { day: utcDay(this.now()), grants: 0 };
  }

  /** Atomic write: a crash mid-write never leaves a truncated state file. */
  private persist(): void {
    mkdirSync(dirname(this.opts.stateFile), { recursive: true });
    const tmp = `${this.opts.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.opts.stateFile);
  }

  /** Reset every counter when the UTC day rolls over. */
  private rollover(): void {
    const today = utcDay(this.now());
    if (this.state.day !== today) {
      this.state = { day: today, grants: 0 };
      this.ipGrants.clear();
      this.persist();
    }
  }

  /**
   * Count one request from `ip` against the hourly request window and check
   * whether a NEW grant would still fit. Does not consume grant budget; call
   * `recordGrant` only once a grant actually lands.
   */
  admit(ip: string): LimitDenial | null {
    this.rollover();

    const nowMs = this.now().getTime();
    const window = this.ipRequests.get(ip);
    if (!window || nowMs - window.windowStart >= 3_600_000) {
      this.ipRequests.set(ip, { windowStart: nowMs, count: 1 });
    } else {
      window.count += 1;
      if (window.count > this.opts.perIpRequestsPerHour) {
        return 'ip_rate';
      }
    }

    if (this.state.grants >= this.opts.dailyGrantCap) {
      return 'daily_budget';
    }
    if ((this.ipGrants.get(ip) ?? 0) >= this.opts.perIpDailyGrantCap) {
      return 'ip_daily';
    }
    return null;
  }

  recordGrant(ip: string): void {
    this.rollover();
    this.state.grants += 1;
    this.ipGrants.set(ip, (this.ipGrants.get(ip) ?? 0) + 1);
    this.persist();
  }

  get grantsToday(): number {
    this.rollover();
    return this.state.grants;
  }
}
