/**
 * deterministic password generator — derive passwords from seed + site + username.
 * nothing stored. same seed always produces the same password.
 */

import { useState, useCallback } from 'react';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { derivePassword, normalizeOrigin, DEFAULT_IDENTITY } from '../../../state/identity';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';

export const PasswordsPage = () => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(s => s.keyRing.getMnemonic);
  const [origin, setOrigin] = useState('');
  const [username, setUsername] = useState('');
  const [length, setLength] = useState(32);
  const [index, setIndex] = useState(0);
  const [password, setPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);

  const generate = useCallback(async () => {
    if (!origin.trim() || !keyInfo) return;
    setGenerating(true);
    try {
      const mnemonic = await getMnemonic(keyInfo.id);
      const result = derivePassword(mnemonic, DEFAULT_IDENTITY, origin.trim(), username.trim(), length, index);
      setPassword(result);
    } catch (e) {
      setPassword(null);
    }
    setGenerating(false);
  }, [origin, username, length, keyInfo, getMnemonic]);

  const copy = () => {
    if (!password) return;
    void navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <SettingsScreen title='passwords' backPath={PopupPath.IDENTITY}>
      <div className='flex flex-col gap-4'>
        <p className='text-[10px] text-fg-dim font-mono'>
          deterministic. nothing stored. same seed = same password.
        </p>

        <div className='flex flex-col gap-3'>
          <input
            type='text'
            value={origin}
            onChange={e => { setOrigin(e.target.value); setPassword(null); }}
            placeholder='site (e.g. github.com)'
            className='w-full rounded border border-border-hard-soft bg-transparent px-3 py-2 text-xs font-mono outline-none focus:border-muted-foreground/60'
          />
          {origin.trim() && normalizeOrigin(origin) !== origin.trim().toLowerCase() && (
            <span className='text-[9px] text-fg-muted/50 font-mono'>→ {normalizeOrigin(origin)}</span>
          )}
          <input
            type='text'
            value={username}
            onChange={e => { setUsername(e.target.value); setPassword(null); }}
            placeholder='username (optional)'
            className='w-full rounded border border-border-hard-soft bg-transparent px-3 py-2 text-xs font-mono outline-none focus:border-muted-foreground/60'
          />
          <div className='flex items-center gap-2'>
            <span className='text-[10px] text-fg-dim font-mono'>length</span>
            <input
              type='range'
              min={16}
              max={64}
              value={length}
              onChange={e => { setLength(Number(e.target.value)); setPassword(null); }}
              className='flex-1'
            />
            <span className='text-[10px] text-fg-muted font-mono w-6 text-right'>{length}</span>
          </div>
          <div className='flex items-center gap-2'>
            <span className='text-[10px] text-fg-dim font-mono'>rotation</span>
            <button
              onClick={() => { setIndex(Math.max(0, index - 1)); setPassword(null); }}
              disabled={index === 0}
              className='text-xs font-mono text-fg-muted hover:text-fg-high disabled:opacity-30 px-1'
            >-</button>
            <span className='text-[10px] text-fg-muted font-mono w-6 text-center'>#{index}</span>
            <button
              onClick={() => { setIndex(index + 1); setPassword(null); }}
              className='text-xs font-mono text-fg-muted hover:text-fg-high px-1'
            >+</button>
            {index > 0 && (
              <span className='text-[9px] text-fg-muted/40 font-mono'>password was rotated {index} time{index !== 1 ? 's' : ''}</span>
            )}
          </div>
        </div>

        <button
          onClick={() => void generate()}
          disabled={!origin.trim() || generating}
          className='rounded border border-border-hard-soft py-2 text-xs font-mono text-fg-muted hover:text-fg-high hover:border-muted-foreground/60 disabled:opacity-30 transition-colors'
        >
          {generating ? 'deriving...' : 'generate'}
        </button>

        {password && (
          <button
            onClick={copy}
            className='w-full rounded border border-border-hard-soft p-3 text-left hover:bg-elev-1 transition-colors'
          >
            <div className='font-mono text-xs break-all select-all leading-relaxed'>
              {password}
            </div>
            <div className='text-[9px] text-fg-muted/50 font-mono mt-2'>
              {copied ? 'copied' : 'tap to copy'}
            </div>
          </button>
        )}
      </div>
    </SettingsScreen>
  );
};
