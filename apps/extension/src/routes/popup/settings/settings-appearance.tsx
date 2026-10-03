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

/**
 * one persisted choice: read once from storage (an external system), written
 * through on pick. `loaded` flips true once that read resolves, so a caller
 * that wants to snapshot the value for a later revert knows when it's real
 * (not just the pre-read placeholder).
 */
const useStoredChoice = <T extends string>(
  initial: T,
  read: () => Promise<T>,
  write: (v: T) => void,
) => {
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void read().then(v => {
      setValue(v);
      setLoaded(true);
    });
  }, []);
  const set = (v: T) => {
    setValue(v);
    write(v);
  };
  // same op as `set`, named for callers reverting to an earlier snapshot
  return { value, loaded, set, restore: set };
};

export const useZafuTheme = () => {
  const { value, loaded, set, restore } = useStoredChoice<ZafuTheme>(
    'sumi',
    // a retired 'terminal' choice falls back to the default
    async () => ((await localExtStorage.get('zafuTheme')) === 'washi' ? 'washi' : 'sumi'),
    t => {
      applyRootData('theme', t, 'sumi');
      void localExtStorage.set('zafuTheme', t);
    },
  );
  return { theme: value, loaded, set, restore };
};

export const ThemeRow = ({ onExplain }: { onExplain?: () => void } = {}) => {
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
      onExplain={onExplain}
    />
  );
};

export const useZafuFont = () => {
  const { value, loaded, set, restore } = useStoredChoice<ZafuFont>(
    'iosevka',
    async () => (await localExtStorage.get('zafuFont')) ?? 'iosevka',
    f => {
      applyRootData('font', f, 'iosevka');
      void localExtStorage.set('zafuFont', f);
    },
  );
  return { font: value, loaded, set, restore };
};

/** uncontrolled by default (own hook instance); pass `state` to share one instance with a parent that needs to read or revert it */
export const FontRow = ({
  state,
  onExplain,
}: {
  state?: ReturnType<typeof useZafuFont>;
  onExplain?: () => void;
} = {}) => {
  const own = useZafuFont();
  const { font, set } = state ?? own;
  return (
    <OptionsRow
      label='type'
      value={font}
      options={[
        { value: 'iosevka', label: 'iosevka term' },
        { value: 'system', label: 'system mono' },
      ]}
      onPick={set}
      onExplain={onExplain}
    />
  );
};

export const useApprovalSurface = () => {
  const { value, loaded, set, restore } = useStoredChoice<ApprovalSurface>(
    'hybrid',
    getApprovalSurface,
    s => {
      void localExtStorage.set('approvalSurface', s);
      // keep the legacy flag in step for anything still reading it
      void localExtStorage.set('approvalsInSidePanel', s !== 'popup');
    },
  );
  return { surface: value, loaded, set, restore };
};

/** uncontrolled by default (own hook instance); pass `state` to share one instance with a parent that needs to read or revert it */
export const ApprovalsRow = ({
  state,
  onExplain,
}: {
  state?: ReturnType<typeof useApprovalSurface>;
  onExplain?: () => void;
} = {}) => {
  const own = useApprovalSurface();
  const { surface, set } = state ?? own;
  return (
    <OptionsRow
      label='approvals open in'
      value={surface}
      options={[
        { value: 'hybrid', label: 'side panel or window', desc: 'a window when no panel can open' },
        { value: 'sidebar', label: 'side panel only' },
        { value: 'popup', label: 'a window' },
      ]}
      onPick={set}
      onExplain={onExplain}
    />
  );
};
