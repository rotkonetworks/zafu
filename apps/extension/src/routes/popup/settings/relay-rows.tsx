/**
 * The relays zafu talks to for people: the people relay (chats, groups, cards)
 * and the contact-discovery relay. Both are plain storage the service worker
 * and the egress policy read directly, so each row follows its key.
 */
import { useState } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { Row } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import {
  DEFAULT_CONTACT_DISCOVERY_RELAY,
  discoveryOn,
  relayEndpointForStorage,
} from '../../../config/contact-discovery-relay';
import {
  DEFAULT_PEOPLE_RELAY,
  movePeopleRelay,
  relayBase,
  relayHost,
} from '../../../config/people-relay';
import { useStored } from './use-stored';

interface Explained {
  onExplain?: (label: string) => void;
}

interface Discovery {
  enabled: boolean;
  relayEndpoint: string;
  relayToken: string;
}

/** read-modify-write, so the toggle and the relay row never overwrite each other's half */
export const saveDiscovery = async (patch: Partial<Discovery>): Promise<void> => {
  const v = await localExtStorage.get('zidDiscovery');
  const next: Discovery = {
    enabled: discoveryOn(v),
    relayEndpoint: v?.relayEndpoint ?? '',
    relayToken: v?.relayToken ?? '',
    ...patch,
  };
  // blank means "the built-in default" (see relayEndpointForStorage)
  next.relayEndpoint = relayEndpointForStorage(next.relayEndpoint);
  next.relayToken = next.relayToken.trim();
  await localExtStorage.set('zidDiscovery', next);
};

/** contact discovery on or off; undefined until read */
export const useDiscoveryOn = () => {
  const stored = useStored('zidDiscovery');
  return stored && discoveryOn(stored.v);
};

/** a relay url typed into a sheet and saved */
const RelaySheet = ({
  open,
  onOpenChange,
  title,
  placeholder,
  initial,
  token,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  placeholder: string;
  initial: string;
  /** the discovery relay may ask for a token */
  token?: string;
  onSave: (endpoint: string, token: string) => Promise<void>;
}) => {
  const [typed, setTyped] = useState(initial);
  const [typedToken, setTypedToken] = useState(token ?? '');
  const valid = !typed.trim() || /^https?:\/\//.test(typed.trim());
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title}>
      <form
        className='flex flex-col gap-3'
        onSubmit={e => {
          e.preventDefault();
          if (valid) {
            void onSave(typed, typedToken).then(() => onOpenChange(false));
          }
        }}
      >
        <Input
          aria-label='relay'
          value={typed}
          onChange={e => setTyped(e.target.value)}
          placeholder={placeholder}
          className='font-mono text-xs'
        />
        {token !== undefined && (
          <Input
            aria-label='token'
            value={typedToken}
            onChange={e => setTypedToken(e.target.value)}
            placeholder='token (only if the relay asks for one)'
            className='font-mono text-xs'
          />
        )}
        <Button type='submit' className='w-full' disabled={!valid}>
          save
        </Button>
      </form>
    </Sheet>
  );
};

/**
 * The relay chats, groups and new cards use. The one it replaces stays
 * allowed, so rooms already living there keep working.
 */
export const PeopleRelayRow = ({ onExplain }: Explained) => {
  const stored = useStored('peopleRelay');
  const [open, setOpen] = useState(false);
  if (!stored) {
    return null;
  }
  const current = relayBase(stored.v?.endpoint ?? '') ?? DEFAULT_PEOPLE_RELAY;
  return (
    <>
      <Row
        type='value'
        label='people relay'
        description='it sees your ip and when, never what you say'
        value={relayHost(current)}
        onPress={() => setOpen(true)}
        onExplain={onExplain}
      />
      {open && (
        <RelaySheet
          open
          onOpenChange={setOpen}
          title='people relay'
          placeholder={DEFAULT_PEOPLE_RELAY}
          initial={current === DEFAULT_PEOPLE_RELAY ? '' : current}
          onSave={async typed => {
            const next = typed.trim() ? relayBase(typed) : DEFAULT_PEOPLE_RELAY;
            if (next) {
              await movePeopleRelay(next);
            }
          }}
        />
      )}
    </>
  );
};

/** where contact discovery leaves its sealed signs */
export const DiscoveryRelayRow = ({ onExplain }: Explained) => {
  const stored = useStored('zidDiscovery');
  const [open, setOpen] = useState(false);
  if (!stored) {
    return null;
  }
  const endpoint = stored.v?.relayEndpoint || DEFAULT_CONTACT_DISCOVERY_RELAY;
  return (
    <>
      <Row
        type='value'
        label='discovery relay'
        description='it sees a sealed sign, your ip and when'
        value={relayHost(endpoint)}
        onPress={() => setOpen(true)}
        onExplain={onExplain}
      />
      {open && (
        <RelaySheet
          open
          onOpenChange={setOpen}
          title='contact-discovery relay'
          placeholder={DEFAULT_CONTACT_DISCOVERY_RELAY}
          initial={endpoint}
          token={stored.v?.relayToken ?? ''}
          onSave={(relayEndpoint, relayToken) => saveDiscovery({ relayEndpoint, relayToken })}
        />
      )}
    </>
  );
};
