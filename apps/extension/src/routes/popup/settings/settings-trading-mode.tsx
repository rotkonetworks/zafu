import { useStore } from '../../../state';
import { tradingModeSelector } from '../../../state/trading-mode';
import { SettingsScreen } from './settings-screen';
import { Switch } from '@repo/ui/components/ui/switch';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { LightningBoltIcon, Cross1Icon } from '@radix-ui/react-icons';
import { useState, useEffect } from 'react';
import type { OriginRecord } from '@repo/storage-chrome/records';

const connectedSitesSelector = (state: { connectedSites: { knownSites: OriginRecord[] } }) =>
  state.connectedSites;

export const SettingsTradingMode = () => {
  const {
    settings,
    setAutoSign,
    addAllowedOrigin,
    removeAllowedOrigin,
    setSessionDuration,
    setMaxValuePerSwap,
    startSession,
    endSession,
    isSessionActive,
    saveTradingMode,
  } = useStore(tradingModeSelector);

  const { knownSites } = useStore(connectedSitesSelector);
  const approvedSites = knownSites.filter((s: OriginRecord) => s.choice === 'Approved');

  const [saving, setSaving] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<string>('');

  useEffect(() => {
    const updateTimer = () => {
      if (settings.expiresAt > Date.now()) {
        const remaining = settings.expiresAt - Date.now();
        const minutes = Math.floor(remaining / 60000);
        const seconds = Math.floor((remaining % 60000) / 1000);
        setTimeRemaining(`${minutes}:${seconds.toString().padStart(2, '0')}`);
      } else {
        setTimeRemaining('');
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [settings.expiresAt]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveTradingMode();
    } finally {
      setSaving(false);
    }
  };

  const handleStartSession = async () => {
    startSession();
    await saveTradingMode();
  };

  const handleEndSession = async () => {
    endSession();
    await saveTradingMode();
  };

  const sessionActive = isSessionActive();

  return (
    <SettingsScreen
      title='Trading Mode'
      IconComponent={() => <LightningBoltIcon className='size-full' />}
    >
      <div className='flex flex-col gap-4'>
        {/* Info Box */}
        <div className='rounded-lg border border-border bg-card-radial p-4'>
          <p className='text-sm text-muted-foreground'>
            Enable auto-signing for swap transactions from whitelisted sites. Sends and withdrawals
            always require manual approval.
          </p>
        </div>

        {/* Session Status */}
        {sessionActive && (
          <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3'>
            <div className='flex items-center justify-between'>
              <div className='flex flex-col'>
                <span className='text-sm font-medium text-green-400'>Session Active</span>
                <span className='text-xs text-muted-foreground'>Expires in {timeRemaining}</span>
              </div>
              <Button variant='secondary' size='sm' onClick={handleEndSession}>
                End
              </Button>
            </div>
          </div>
        )}

        {/* Auto-sign Toggle */}
        <div className='border-t border-border pt-4'>
          <div className='flex items-center justify-between'>
            <div className='flex flex-col gap-1'>
              <span className='text-sm font-bold'>Auto-sign Swaps</span>
              <span className='text-xs text-muted-foreground'>
                Only swap transactions are auto-signed
              </span>
            </div>
            <Switch checked={settings.autoSign} onCheckedChange={setAutoSign} />
          </div>
        </div>

        {settings.autoSign && (
          <>
            {/* Session Duration */}
            <div className='border-t border-border pt-4'>
              <p className='text-sm font-bold mb-3'>Session Duration</p>
              <div className='flex items-center gap-2'>
                <Input
                  type='number'
                  min={1}
                  max={480}
                  value={settings.sessionDurationMinutes}
                  onChange={e => setSessionDuration(parseInt(e.target.value) || 30)}
                  className='w-20'
                />
                <span className='text-sm text-muted-foreground'>minutes (1-480)</span>
              </div>
            </div>

            {/* Max Value */}
            <div className='border-t border-border pt-4'>
              <p className='text-sm font-bold mb-3'>Max Value Per Swap</p>
              <div className='flex items-center gap-2'>
                <Input
                  type='text'
                  value={settings.maxValuePerSwap === '0' ? '' : settings.maxValuePerSwap}
                  onChange={e => setMaxValuePerSwap(e.target.value || '0')}
                  placeholder='Unlimited'
                  className='flex-1'
                />
                <span className='text-sm text-muted-foreground'>base units</span>
              </div>
              <p className='text-xs text-muted-foreground mt-1'>Leave empty for no limit</p>
            </div>

            {/* Allowed Origins */}
            <div className='border-t border-border pt-4'>
              <p className='text-sm font-bold mb-3'>Allowed Sites</p>

              {settings.allowedOrigins.length === 0 ? (
                <div className='rounded-lg border border-border bg-card-radial p-3'>
                  <p className='text-xs text-muted-foreground'>
                    No sites selected. Add at least one site to enable auto-signing.
                  </p>
                </div>
              ) : (
                <div className='flex flex-col gap-2 mb-3'>
                  {settings.allowedOrigins.map((origin: string) => (
                    <div
                      key={origin}
                      className='flex items-center justify-between rounded-lg border border-border bg-card-radial p-3'
                    >
                      <span className='text-sm truncate'>{new URL(origin).hostname}</span>
                      <button
                        onClick={() => removeAllowedOrigin(origin)}
                        className='text-muted-foreground hover:text-red-400'
                      >
                        <Cross1Icon className='size-4' />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {approvedSites.filter((s: OriginRecord) => !settings.allowedOrigins.includes(s.origin))
                .length > 0 && (
                <div className='flex flex-wrap gap-2'>
                  {approvedSites
                    .filter((s: OriginRecord) => !settings.allowedOrigins.includes(s.origin))
                    .map((site: OriginRecord) => (
                      <Button
                        key={site.origin}
                        variant='secondary'
                        size='sm'
                        onClick={() => addAllowedOrigin(site.origin)}
                      >
                        + {new URL(site.origin).hostname}
                      </Button>
                    ))}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className='border-t border-border pt-4'>
              <div className='flex gap-2'>
                <Button
                  variant='secondary'
                  className='flex-1'
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                {!sessionActive && settings.allowedOrigins.length > 0 && (
                  <Button variant='gradient' className='flex-1' onClick={handleStartSession}>
                    Start Session
                  </Button>
                )}
              </div>
            </div>
          </>
        )}

        {!settings.autoSign && (
          <div className='border-t border-border pt-4'>
            <Button variant='secondary' className='w-full' onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        )}
      </div>
    </SettingsScreen>
  );
};
