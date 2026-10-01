import { useEffect, useState } from 'react';
import { CAPABILITY_META, type Capability } from '@repo/storage-chrome/capabilities';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { cn } from '@repo/ui/lib/utils';
import { Segmented } from '@repo/ui/components/ui/segmented';
import { getCapabilityModes, setCapabilityMode } from '../../../state/capability-modes';
import type { CapabilityMode, CapabilityModeMap } from '../../../utils/capability-decision';

/**
 * Per-capability participation switch, the settings half of the opt-in asked
 * in the approval popup. Three states, one row each:
 *
 *   ask  (unset) - first site that asks gets the one-time zafu prompt
 *   on   (enabled) - sites go straight to their own per-origin consent
 *   off  (disabled) - the wallet refuses, for every site, without asking
 *
 * `off` is deliberately not a per-origin denial: a per-origin denial is a
 * decision about one site and is reversible from that site's row; this switch
 * is the global "zafu does not do this", so it must be reachable without
 * hunting through connected sites.
 */
const MODES: readonly { value: CapabilityMode; label: string }[] = [
  { value: 'unset', label: 'ask' },
  { value: 'enabled', label: 'on' },
  { value: 'disabled', label: 'off' },
];

const RISK_TEXT: Record<string, string> = {
  low: 'text-fg-muted',
  medium: 'text-yellow-400',
  high: 'text-orange-400',
  critical: 'text-red-400',
};

export const SettingsFeatures = () => {
  const [modes, setModes] = useState<CapabilityModeMap | null>(null);

  useEffect(() => {
    void getCapabilityModes().then(setModes);
  }, []);

  const set = (cap: Capability, mode: CapabilityMode): void => {
    setModes(m => (m ? { ...m, [cap]: mode } : m));
    void setCapabilityMode(cap, mode);
  };

  return (
    <SettingsScreen title='features' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-2 px-4 pb-4'>
        <p className='text-xs text-fg-muted'>
          what zafu offers sites at all. every site still gets its own permission request the first
          time it asks.
        </p>
        {modes === null
          ? null
          : (Object.keys(CAPABILITY_META) as Capability[]).map(cap => {
              const meta = CAPABILITY_META[cap];
              const current = modes[cap] ?? 'unset';
              return (
                <div
                  key={cap}
                  className='flex items-start justify-between gap-3 border border-border-soft bg-elev-1 p-3'
                >
                  <div className='flex min-w-0 flex-col gap-1'>
                    <span className='flex items-center gap-2 text-sm text-fg-high'>
                      {meta.label}
                      <span className={cn('text-label lowercase', RISK_TEXT[meta.risk])}>
                        {meta.risk}
                      </span>
                    </span>
                    <span className='text-xs text-fg-muted'>{meta.description}</span>
                  </div>
                  <Segmented
                    className='shrink-0'
                    label={`${meta.label} mode`}
                    value={current}
                    onChange={mode => set(cap, mode)}
                    options={MODES}
                  />
                </div>
              );
            })}
      </div>
    </SettingsScreen>
  );
};
