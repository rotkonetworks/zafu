/**
 * Voting endpoints settings.
 *
 * Shows the vote-server + PIR endpoints the bundled voting config names (see
 * services/voting/bundled-config.ts) - read-only, no network, no override:
 * the config ships with the release instead of being fetched.
 */

import { BUNDLED_SERVICE_CONFIG } from '../../../services/voting/bundled-config';
import type { ServiceEndpoint } from '../../../services/voting/types';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';

function EndpointList({ title, endpoints }: { title: string; endpoints: ServiceEndpoint[] }) {
  return (
    <div>
      <p className='kicker px-0 pb-1'>{title}</p>
      {endpoints.length === 0 ? (
        <p className='text-label text-fg-dim'>none</p>
      ) : (
        <div className='flex flex-col gap-1'>
          {endpoints.map(e => (
            <div key={e.url} className='border border-border-soft/40 bg-elev-1 px-2 py-1.5'>
              <p className='text-data text-fg-high'>{e.label || e.url}</p>
              <p className='break-all text-label text-fg-muted'>{e.url}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const SettingsVoting = () => (
  <SettingsScreen title='voting servers' backPath={PopupPath.SETTINGS_ZCASH_NETWORK}>
    <div className='flex flex-col gap-5'>
      <p className='text-data text-fg-high'>source: bundled with this release</p>
      <div className='flex flex-col gap-3'>
        <EndpointList title='vote servers' endpoints={BUNDLED_SERVICE_CONFIG.vote_servers} />
        <EndpointList title='pir endpoints' endpoints={BUNDLED_SERVICE_CONFIG.pir_endpoints} />
      </div>
    </div>
  </SettingsScreen>
);
