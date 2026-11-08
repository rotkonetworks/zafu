/**
 * "your proxy", beside send over nym: the person's own proxy for zafu's
 * traffic only (net/proxy). Chrome's permissions are asked at the moment it
 * is turned on; the login is sealed; while it is chosen but not applied,
 * zafu sends nothing rather than going direct.
 */

import { useEffect, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Segmented } from '@repo/ui/components/ui/segmented';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncrypted, writeEncrypted } from '../../../state/encrypted-storage';
import { hostOf } from '../../../net/destination';
import { primeIn, primerUrl } from '../../../net/proxy-primer';
import {
  isProxyConfig,
  isProxyLogin,
  PROXY_APPLIED_KEY,
  PROXY_KEY,
  PROXY_LOGIN_KEY,
  type ProxyApplied,
  type ProxyConfig,
  type ProxyKind,
} from '../../../net/proxy';

/**
 * what Chrome is asked for: only a login needs anything (its auth hook);
 * `proxy` itself can't be optional, so it is in the manifest and does
 * nothing until a proxy is set here
 */
const permissionsFor = (kind: ProxyKind): string[] =>
  kind === 'socks5' ? [] : ['webRequest', 'webRequestAuthProvider'];

/** true when chrome granted what this kind needs (nothing to ask for socks5) */
const grant = (kind: ProxyKind): Promise<boolean> => {
  const permissions = permissionsFor(kind);
  return permissions.length ? chrome.permissions.request({ permissions }) : Promise.resolve(true);
};

const STATUS: Record<ProxyApplied, { tone: 'info' | 'warn'; line: string }> = {
  ok: { tone: 'info', line: "through your proxy · only zafu's own traffic" },
  'no-permission': {
    tone: 'warn',
    line: "chrome hasn't allowed zafu to give the proxy its login · zafu sends nothing until it does",
  },
  'other-extension': {
    tone: 'warn',
    line: 'another extension controls the proxy · zafu sends nothing meanwhile',
  },
};

const LOGIN_KEY = PROXY_LOGIN_KEY as never;

const useStored = () => {
  const [state, setState] = useState<{ p?: ProxyConfig; applied?: ProxyApplied }>({});
  useEffect(() => {
    const read = () =>
      void chrome.storage.local.get([PROXY_KEY, PROXY_APPLIED_KEY]).then(r =>
        setState({
          p: isProxyConfig(r[PROXY_KEY]) ? r[PROXY_KEY] : undefined,
          applied: r[PROXY_APPLIED_KEY] as ProxyApplied | undefined,
        }),
      );
    read();
    const l = (changes: Record<string, unknown>) => {
      if (PROXY_KEY in changes || PROXY_APPLIED_KEY in changes) {
        read();
      }
    };
    chrome.storage.local.onChanged.addListener(l);
    return () => chrome.storage.local.onChanged.removeListener(l);
  }, []);
  return state;
};

export function ProxyRows() {
  const { p, applied } = useStored();
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* no-explain: its value says what goes through it, the sheet says the rest */}
      <Row
        type='value'
        label='your proxy'
        value={p?.on ? `${p.kind} · ${p.host}` : 'off'}
        tone={p?.on && applied !== 'ok' ? 'warn' : undefined}
        onPress={() => setOpen(true)}
      />
      <Sheet open={open} onOpenChange={setOpen} title='your proxy'>
        {open && <ProxyForm p={p} applied={applied} onDone={() => setOpen(false)} />}
      </Sheet>
    </>
  );
}

function ProxyForm({
  p,
  applied,
  onDone,
}: {
  p?: ProxyConfig;
  applied?: ProxyApplied;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<ProxyKind>(p?.kind ?? 'http');
  const [host, setHost] = useState(p?.host ?? '');
  const [port, setPort] = useState(p ? String(p.port) : '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [line, setLine] = useState<string>();
  useEffect(() => {
    void readEncrypted<unknown>(localExtStorage, sessionExtStorage, LOGIN_KEY)
      .then(l => {
        if (isProxyLogin(l)) {
          setUsername(l.username);
          setPassword(l.password);
        }
      })
      .catch(() => undefined);
  }, []);

  const next: ProxyConfig = { kind, host: host.trim(), port: Number(port), on: true };
  const valid = isProxyConfig(next);

  const save = async (on: boolean) => {
    if (on) {
      // asked here, at the tap: chrome only grants a permission to a gesture
      const granted = await grant(kind);
      if (!granted) {
        setLine("chrome didn't allow it · nothing changed");
        return;
      }
      if (kind !== 'socks5' && username) {
        await writeEncrypted(localExtStorage, sessionExtStorage, LOGIN_KEY, {
          username,
          password,
        });
      } else {
        await chrome.storage.local.remove(PROXY_LOGIN_KEY);
      }
    }
    await chrome.storage.local.set({ [PROXY_KEY]: { ...next, on } });
    onDone();
  };

  /** one request to the zcash node: through the proxy now, or refused */
  const check = async () => {
    setLine('asking your zcash node through the proxy…');
    try {
      const { networkEndpoints } = await chrome.storage.local.get('networkEndpoints');
      const node =
        (networkEndpoints as Record<string, string> | undefined)?.['zcash'] ??
        'https://zcash.rotko.net';
      // the proxy's login first: chrome answers it for a frame, not for zafu's own fetch
      const host = hostOf(node);
      if (host && p?.kind !== 'socks5') {
        await primeIn(document, primerUrl(host));
      }
      await fetch(node, { method: 'GET', cache: 'no-store' });
      setLine('your node answered through the proxy');
    } catch (e) {
      setLine(
        e instanceof Error && e.message.includes('proxy')
          ? e.message
          : "the proxy didn't answer · nothing was sent",
      );
    }
  };

  return (
    <div className='flex flex-col gap-3 pb-2'>
      {p?.on && applied && (
        <StatusSlot
          tone={STATUS[applied].tone}
          icon='i-ph-plug'
          action={
            applied === 'no-permission'
              ? {
                  label: 'allow',
                  onClick: () => void grant(p.kind),
                }
              : undefined
          }
        >
          {STATUS[applied].line}
        </StatusSlot>
      )}
      <Segmented
        label='kind'
        value={kind}
        onChange={setKind}
        options={[
          { value: 'http', label: 'http' },
          { value: 'https', label: 'https' },
          { value: 'socks5', label: 'socks5' },
        ]}
      />
      <div className='flex gap-2'>
        <Input
          aria-label='host'
          placeholder='host'
          value={host}
          onChange={e => setHost(e.target.value)}
          className='grow'
        />
        <Input
          aria-label='port'
          placeholder='port'
          inputMode='numeric'
          value={port}
          onChange={e => setPort(e.target.value.replace(/\D/g, ''))}
          className='w-[90px]'
        />
      </div>
      {kind === 'socks5' ? (
        <span className='text-label text-fg-muted'>
          chrome can't log in to socks5 · for tor, or a proxy with no login
        </span>
      ) : (
        <div className='flex gap-2'>
          <Input
            aria-label='username'
            placeholder='username'
            autoComplete='off'
            value={username}
            onChange={e => setUsername(e.target.value)}
          />
          <Input
            aria-label='password'
            placeholder='password'
            type='password'
            autoComplete='off'
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
        </div>
      )}
      <span className='text-label text-fg-muted'>
        only zafu&apos;s own traffic · nym rests while it is on · if the proxy is down, nothing goes
        direct
      </span>
      {line && <span className='text-label text-fg-muted'>{line}</span>}
      {p?.on && (
        <RowGroup>
          <Row type='screen' label='check it' onPress={() => void check()} />
        </RowGroup>
      )}
      <div className='flex gap-2'>
        {p?.on && (
          <Button variant='secondary' className='w-[110px]' onClick={() => void save(false)}>
            turn off
          </Button>
        )}
        <Button className='grow' disabled={!valid} onClick={() => void save(true)}>
          {p?.on ? 'save' : 'use it for zafu'}
        </Button>
      </div>
    </div>
  );
}
