import { useEffect, useState } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { getApprovalSurface, type ApprovalSurface } from '../../../side-panel-pref';
import { OptionsRow } from './sheet-options';

/**
 * appearance - theme, type and where approvals open, each a value row with a
 * sheet of options, applied instantly and persisted locally.
 */

export type ZafuTheme = 'sumi' | 'washi';
type ZafuFont = 'iosevka' | 'system';

/** sumi and iosevka are the :root defaults, so only the other choice sets a data attribute */
const applyRootData = (key: 'theme' | 'font', value: string, fallback: string) => {
  if (value === fallback) {
    delete document.documentElement.dataset[key];
  } else {
    document.documentElement.dataset[key] = value;
  }
};

/** one persisted choice: read once from storage (an external system), written through on pick */
const useStoredChoice = <T extends string>(
  initial: T,
  read: () => Promise<T>,
  write: (v: T) => void,
) => {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    void read().then(setValue);
  }, []);
  return {
    value,
    set: (v: T) => {
      setValue(v);
      write(v);
    },
  };
};

export const useZafuTheme = () => {
  const { value, set } = useStoredChoice<ZafuTheme>(
    'sumi',
    // a retired 'terminal' choice falls back to the default
    async () => ((await localExtStorage.get('zafuTheme')) === 'washi' ? 'washi' : 'sumi'),
    t => {
      applyRootData('theme', t, 'sumi');
      void localExtStorage.set('zafuTheme', t);
    },
  );
  return { theme: value, set };
};

export const ThemeRow = () => {
  const { theme, set } = useZafuTheme();
  return (
    <OptionsRow
      label='theme'
      value={theme}
      options={[
        { value: 'sumi', label: 'sumi', desc: 'warm ink on woven cloth' },
        { value: 'washi', label: 'washi', desc: 'ink on unbleached paper' },
      ]}
      onPick={set}
    />
  );
};

export const FontRow = () => {
  const { value, set } = useStoredChoice<ZafuFont>(
    'iosevka',
    async () => (await localExtStorage.get('zafuFont')) ?? 'iosevka',
    f => {
      applyRootData('font', f, 'iosevka');
      void localExtStorage.set('zafuFont', f);
    },
  );
  return (
    <OptionsRow
      label='type'
      value={value}
      options={[
        { value: 'iosevka', label: 'iosevka term' },
        { value: 'system', label: 'system mono' },
      ]}
      onPick={set}
    />
  );
};

export const ApprovalsRow = () => {
  const { value, set } = useStoredChoice<ApprovalSurface>('hybrid', getApprovalSurface, s => {
    void localExtStorage.set('approvalSurface', s);
    // keep the legacy flag in step for anything still reading it
    void localExtStorage.set('approvalsInSidePanel', s !== 'popup');
  });
  return (
    <OptionsRow
      label='approvals open in'
      value={value}
      options={[
        { value: 'hybrid', label: 'side panel or window', desc: 'a window when no panel can open' },
        { value: 'sidebar', label: 'side panel only' },
        { value: 'popup', label: 'a window' },
      ]}
      onPick={set}
    />
  );
};
