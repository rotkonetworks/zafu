import { Input } from '@repo/ui/components/ui/input';

/**
 * What they should call you in this one group. Optional: left empty, the
 * group sees a word name made for you there, and nothing else.
 */
export const NickField = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) => (
  <label className='flex flex-col gap-1.5'>
    <span className='text-xs tracking-[0.04em] text-fg-muted'>what should they call you here?</span>
    <Input
      aria-label='what should they call you here?'
      placeholder='optional'
      value={value}
      maxLength={24}
      autoComplete='off'
      spellCheck={false}
      onChange={e => onChange(e.target.value.replace(/[\r\n]/g, ''))}
    />
  </label>
);
