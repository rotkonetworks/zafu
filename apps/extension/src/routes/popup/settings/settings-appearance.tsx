import { useEffect, useState } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { cn } from '@repo/ui/lib/utils';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';

/**
 * appearance — theme and type, applied instantly, persisted locally.
 *
 * Themes are one material language in three states (see globals.css):
 *   sumi ink  — warm ink-stone dark (default)
 *   washi     — sumi ink on unbleached paper (light)
 *   terminal  — the original cold pure black
 */

type ZafuTheme = 'sumi' | 'washi' | 'terminal';
type ZafuFont = 'iosevka' | 'system';

const THEMES: { id: ZafuTheme; name: string; blurb: string; chip: string; ink: string }[] = [
  {
    id: 'sumi',
    name: 'sumi ink',
    blurb: 'warm ink on woven cloth',
    chip: '#0c0a08',
    ink: '#ded5c4',
  },
  { id: 'washi', name: 'washi', blurb: 'ink on unbleached paper', chip: '#efe9dc', ink: '#2b241c' },
  {
    id: 'terminal',
    name: 'terminal',
    blurb: 'cold black, no cloth',
    chip: '#000000',
    ink: '#dcdcdc',
  },
];

const FONTS: { id: ZafuFont; name: string; blurb: string; stack: string }[] = [
  {
    id: 'iosevka',
    name: 'iosevka term',
    blurb: 'the zafu voice — narrow, confident',
    stack: "'Iosevka Term', 'Courier New', Courier, monospace",
  },
  {
    id: 'system',
    name: 'system mono',
    blurb: 'whatever your OS considers monospace',
    stack: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  },
];

const applyTheme = (theme: ZafuTheme) => {
  if (theme === 'sumi') {
    delete document.documentElement.dataset['theme'];
  } else {
    document.documentElement.dataset['theme'] = theme;
  }
};

const applyFont = (font: ZafuFont) => {
  if (font === 'system') {
    document.documentElement.dataset['font'] = font;
  } else {
    delete document.documentElement.dataset['font'];
  }
};

export const SettingsAppearance = () => {
  const [theme, setTheme] = useState<ZafuTheme>('sumi');
  const [font, setFont] = useState<ZafuFont>('iosevka');
  const [approvalsInSidePanel, setApprovalsInSidePanel] = useState(true);

  useEffect(() => {
    void localExtStorage.get('zafuTheme').then(v => setTheme(v ?? 'sumi'));
    void localExtStorage.get('zafuFont').then(v => setFont(v ?? 'iosevka'));
    void localExtStorage.get('approvalsInSidePanel').then(v => setApprovalsInSidePanel(v ?? true));
  }, []);

  const pickApprovalMode = (inSidePanel: boolean) => {
    setApprovalsInSidePanel(inSidePanel);
    void localExtStorage.set('approvalsInSidePanel', inSidePanel);
  };

  const APPROVAL_MODES = [
    { id: false, name: 'popup window', blurb: 'approvals open in a separate window' },
    { id: true, name: 'side panel', blurb: 'approvals appear in the panel when open' },
  ] as const;

  const pickTheme = (t: ZafuTheme) => {
    setTheme(t);
    applyTheme(t);
    void localExtStorage.set('zafuTheme', t);
  };

  const pickFont = (f: ZafuFont) => {
    setFont(f);
    applyFont(f);
    void localExtStorage.set('zafuFont', f);
  };

  return (
    <SettingsScreen title='appearance' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-5 px-4'>
        <div>
          <p className='kicker pb-2'>theme</p>
          <div className='flex flex-col gap-2'>
            {THEMES.map(t => (
              <button
                key={t.id}
                onClick={() => pickTheme(t.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
                  theme === t.id
                    ? 'border-zigner-gold/60 bg-elev-1'
                    : 'border-border-soft hover:bg-elev-1',
                )}
              >
                {/* material chip: canvas swatch with an ink stroke */}
                <span
                  className='flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-border-soft text-[13px]'
                  style={{ background: t.chip, color: t.ink }}
                >
                  あ
                </span>
                <span className='flex flex-1 flex-col'>
                  <span className='text-data text-fg lowercase'>{t.name}</span>
                  <span className='text-label text-fg-dim lowercase'>{t.blurb}</span>
                </span>
                {theme === t.id && <span className='i-ph-check size-4 text-zigner-gold' />}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className='kicker pb-2'>type</p>
          <div className='flex flex-col gap-2'>
            {FONTS.map(f => (
              <button
                key={f.id}
                onClick={() => pickFont(f.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
                  font === f.id
                    ? 'border-zigner-gold/60 bg-elev-1'
                    : 'border-border-soft hover:bg-elev-1',
                )}
              >
                <span
                  className='flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-border-soft bg-elev-2 text-title text-fg'
                  style={{ fontFamily: f.stack }}
                >
                  Aa
                </span>
                <span className='flex flex-1 flex-col'>
                  <span className='text-data text-fg lowercase'>{f.name}</span>
                  <span className='text-label text-fg-dim lowercase'>{f.blurb}</span>
                </span>
                {font === f.id && <span className='i-ph-check size-4 text-zigner-gold' />}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className='kicker pb-2'>approvals</p>
          <div className='flex flex-col gap-2'>
            {APPROVAL_MODES.map(m => (
              <button
                key={String(m.id)}
                onClick={() => pickApprovalMode(m.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
                  approvalsInSidePanel === m.id
                    ? 'border-zigner-gold/60 bg-elev-1'
                    : 'border-border-soft hover:bg-elev-1',
                )}
              >
                <span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-border-soft bg-elev-2 text-fg'>
                  <span className={cn(m.id ? 'i-ph-sidebar-simple' : 'i-ph-app-window', 'size-4')} />
                </span>
                <span className='flex flex-1 flex-col'>
                  <span className='text-data text-fg lowercase'>{m.name}</span>
                  <span className='text-label text-fg-dim lowercase'>{m.blurb}</span>
                </span>
                {approvalsInSidePanel === m.id && (
                  <span className='i-ph-check size-4 text-zigner-gold' />
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    </SettingsScreen>
  );
};
