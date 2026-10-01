import { ScreenHeader } from '../../../../components/screen-header';
import { ReactNode } from 'react';
import { PopupPath } from '../../paths';
import { RowGroup } from '@repo/ui/components/ui/row';

/** the four settings categories and their kanji, shared by the index cards and every header */
export const CATEGORY_MARKS = {
  security: { mark: '守', tone: 'text-hanko' },
  privacy: { mark: '秘', tone: 'text-zigner-gold' },
  networks: { mark: '道', tone: 'text-fg-high' },
  devices: { mark: '器', tone: 'text-fg-muted' },
} as const;

export type SettingsCategory = keyof typeof CATEGORY_MARKS;

export const SettingsScreen = ({
  title,
  children,
  backPath,
  onBack,
  category,
  meta,
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
      <div className='flex grow flex-col px-4 pb-4 pt-4'>{children}</div>
    </div>
  );
};

/** a titled group of rows, as on the "all ... controls" boards */
export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className='flex flex-col gap-1.5'>
    <h2 className='text-[11px]/[14px] tracking-[0.06em] text-fg-muted'>{title}</h2>
    <RowGroup>{children}</RowGroup>
  </section>
);
