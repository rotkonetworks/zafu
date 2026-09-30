import { SeedPhraseLength } from '../../state/seed-phrase/mnemonic';
import { Segmented } from '@repo/ui/components/ui/segmented';

interface WordLengthTooglesProsp {
  toogleClick: (length: SeedPhraseLength) => void;
  phrase: string[];
}

export const WordLengthToogles = ({ toogleClick, phrase }: WordLengthTooglesProsp) => {
  const value = phrase.length === 24 ? '24' : '12';
  return (
    <div className='flex items-center justify-center'>
      <Segmented
        label='seed phrase length'
        value={value}
        onChange={next =>
          toogleClick(next === '24' ? SeedPhraseLength.TWENTY_FOUR_WORDS : SeedPhraseLength.TWELVE_WORDS)
        }
        options={[
          { value: '12', label: '12 words' },
          { value: '24', label: '24 words' },
        ]}
      />
    </div>
  );
};
