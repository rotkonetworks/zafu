/**
 * sites that know you (IdSites.dc.html): each site and the identity it
 * holds. A sheet per site: start fresh there, let friends find you there
 * (off until turned on), its permissions as a second step, or disconnect it.
 * Also the screen behind settings > connected sites.
 */

import { useEffect, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { ZidSeal } from '@repo/ui/components/ui/zid-seal';
import { denyCapability, grantCapability, revokeOrigin } from '@repo/storage-chrome/origin';
import { CAPABILITY_META, hasCapability, type Capability } from '@repo/storage-chrome/capabilities';
import { revokeOrigin as endSessions } from '../../../senders/revoke';
import { discoveryEnabled, setSiteFindsFriends } from '../../../state/find-friends';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';
import { hostOf, knownLine, setSitePref, shortDay, useSites, type SiteIdentity } from './site-list';

const CAPS: Capability[] = [
  'connect',
  'sign_identity',
  'send_tx',
  'export_fvk',
  'view_contacts',
  'view_history',
  'frost',
  'passkey',
  'encrypt',
];

const SiteSheet = ({
  site,
  onChanged,
  onDone,
}: {
  site: SiteIdentity;
  /** something about the site changed: read it again, keep the sheet */
  onChanged: () => void;
  onDone: () => void;
}) => {
  const [fresh, setFresh] = useState(false);
  const [perms, setPerms] = useState(false);
  const [find, setFind] = useState(false);
  useEffect(() => {
    void discoveryEnabled().then(on => setFind(on && site.pref.findFriends === true));
  }, [site]);
  const host = hostOf(site.origin);

  return (
    <Sheet open onOpenChange={o => !o && onDone()} title={perms ? `${host} may` : host}>
      {perms ? (
        <RowGroup>
          {CAPS.map(cap => (
            <Row
              key={cap}
              type='toggle'
              label={CAPABILITY_META[cap].label}
              checked={hasCapability(site.perms, cap)}
              onChange={on =>
                void (
                  on ? grantCapability(site.origin, cap) : denyCapability(site.origin, cap)
                ).then(onChanged)
              }
            />
          ))}
        </RowGroup>
      ) : (
        <>
          <span className='text-[13px] text-fg'>
            {fresh
              ? 'now knows you as a new identity'
              : `${knownLine(site)}${site.since ? ` since ${shortDay(site.since)}` : ''}`}
          </span>
          <Button
            disabled={fresh}
            onClick={() =>
              void setSitePref(site.origin, {
                ...site.pref,
                mode: 'site',
                rotation: site.pref.rotation + 1,
              }).then(() => {
                setFresh(true);
                onChanged();
              })
            }
          >
            {fresh ? 'done · fresh identity' : 'start fresh on this site'}
          </Button>
          <span className='text-[11px] text-fg-muted'>
            the site sees a new, unrelated identity. anything tied to the old one stays with it.
          </span>
          <RowGroup>
            <Row
              type='toggle'
              label='friends can find you here'
              description='you see them only if they can see you'
              checked={find}
              onChange={on => void setSiteFindsFriends(site.origin, on).then(() => setFind(on))}
            />
            {site.perms && <Row type='screen' label='permissions' onPress={() => setPerms(true)} />}
          </RowGroup>
          <Button
            variant='danger'
            onClick={() => {
              endSessions(site.origin);
              void revokeOrigin(site.origin).then(onDone);
            }}
          >
            disconnect this site
          </Button>
        </>
      )}
    </Sheet>
  );
};

export const SitesPage = () => {
  const { sites, reload } = useSites();
  const [open, setOpen] = useState<string>();
  const site = sites.find(s => s.origin === open);

  return (
    <SettingsScreen title='sites that know you' backPath={PopupPath.IDENTITY}>
      <div className='flex flex-col gap-2.5'>
        <span className='text-xs text-fg-muted'>
          each site gets its own identity. none can tell it is you on another.
        </span>
        {sites.length ? (
          <RowGroup>
            {sites.map(s => (
              <Row
                key={s.origin}
                type='screen'
                media={<ZidSeal hex={s.shares.at(-1)?.publicKey} size={26} tone='hanko' />}
                label={hostOf(s.origin)}
                description={knownLine(s)}
                onPress={() => setOpen(s.origin)}
              />
            ))}
          </RowGroup>
        ) : (
          <span className='py-4 text-[13px] text-fg-muted'>no site knows you yet</span>
        )}
      </div>
      {site && (
        <SiteSheet
          key={site.origin}
          site={site}
          onChanged={reload}
          onDone={() => {
            reload();
            setOpen(undefined);
          }}
        />
      )}
    </SettingsScreen>
  );
};

export default SitesPage;
