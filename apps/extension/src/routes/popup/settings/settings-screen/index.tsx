import { ScreenHeader } from '../../../../components/screen-header';
import { ReactNode } from 'react';
import { PopupPath } from '../../paths';
import { RowGroup } from '@repo/ui/components/ui/row';

/** the six settings groups and their kanji, shared by the index cards and every header */
export const CATEGORY_MARKS = {
  security: { mark: '守', tone: 'text-hanko', tagline: 'only you can open or sign' },
  network: { mark: '道', tone: 'text-fg-high', tagline: 'who sees you online' },
  zcash: { mark: '秘', tone: 'text-zigner-gold', tagline: 'what your zcash node learns' },
  people: { mark: '人', tone: 'text-fg-muted', tagline: 'who can find you' },
  display: { mark: '見', tone: 'text-fg-muted', tagline: '' },
  devices: { mark: '器', tone: 'text-fg-muted', tagline: '' },
} as const;

export type SettingsCategory = keyof typeof CATEGORY_MARKS;

export const SettingsScreen = ({
  title,
  children,
  backPath,
  onBack,
  category,
  meta,
  home,
}: {
  title: string;
  children: ReactNode;
  backPath?: PopupPath | false;
  /** overrides back-arrow behavior (e.g. to confirm before leaving a live session). */
  onBack?: () => void;
  /** shows the category kanji right of the title */
  category?: SettingsCategory;
  /** small text before the kanji, e.g. the wallet a screen acts on */
  meta?: ReactNode;
  /** a group's own screen: its tagline sits under the header */
  home?: boolean;
}) => {
  const mark = category && CATEGORY_MARKS[category];
  return (
    <div className='flex min-h-full w-full flex-col'>
      <ScreenHeader
        title={title}
        backPath={backPath}
        onBack={onBack}
        meta={
          (meta || mark) && (
            <>
              {meta}
              {mark && <span className={`font-display text-lg ${mark.tone}`}>{mark.mark}</span>}
            </>
          )
        }
      />
      <div className='flex grow flex-col px-4 pb-4 pt-3'>
        {home && mark?.tagline && <p className='mb-2.5 text-[11px] text-fg-dim'>{mark.tagline}</p>}
        {children}
      </div>
    </div>
  );
};

/** a titled group of rows */
export const Section = ({
  title,
  aside,
  children,
}: {
  title?: string;
  /** a short warning at the right of the title */
  aside?: string;
  children: ReactNode;
}) => (
  <section className='flex flex-col gap-1.5'>
    {title && (
      <h2 className='flex justify-between text-[11px]/[14px] tracking-[0.06em] text-fg-muted'>
        {title}
        {aside && <span className='text-warn'>{aside}</span>}
      </h2>
    )}
    <RowGroup>{children}</RowGroup>
  </section>
);
