import { useState } from 'react';
import { CopyToClipboard } from '@repo/ui/components/ui/copy-to-clipboard';
import { PasswordInput } from '../../../shared/components/password-input';
import { useStore } from '../../../state';
import { passwordSelector } from '../../../state/password';
import { walletsSelector } from '../../../state/wallets';
import { SettingsScreen } from './settings-screen';

export const SettingsPassphrase = () => {
  const { isPassword } = useStore(passwordSelector);
  const { getSeedPhrase } = useStore(walletsSelector);

  const [password, setPassword] = useState('');
  const [enteredIncorrect, setEnteredIncorrect] = useState(false);
  const [phrase, setPhrase] = useState<string[]>([]);

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    void (async function () {
      if (await isPassword(password)) {
        setPassword('');
        setPhrase(await getSeedPhrase());
      } else {
        setEnteredIncorrect(true);
      }
    })();
  };

  return (
    <SettingsScreen title='recovery passphrase'>
      <div className='flex flex-col gap-4'>
        <p className='text-sm text-muted-foreground'>
          if you change browser or switch to another computer, you will need this recovery
          passphrase to access your accounts.
        </p>
        <p className='flex items-center gap-2 text-xs text-rust'>
          <span className='i-lucide-triangle-alert size-4' />
          don't share this phrase with anyone
        </p>

        {!phrase.length ? (
          <form onSubmit={submit} className='flex flex-col gap-3'>
            <PasswordInput
              passwordValue={password}
              label={<p className='text-sm text-muted-foreground'>password</p>}
              onChange={e => {
                setPassword(e.target.value);
                setEnteredIncorrect(false);
              }}
              validations={[
                {
                  type: 'error',
                  issue: 'wrong password',
                  checkFn: (txt: string) => Boolean(txt) && enteredIncorrect,
                },
              ]}
            />
            <button
              type='submit'
              className='w-full rounded-lg bg-primary py-2.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90'
            >
              confirm
            </button>
          </form>
        ) : (
          <div className='flex flex-col gap-3'>
            <div
              className='select-all cursor-text rounded-lg bg-background border border-border/40 p-3 text-xs leading-relaxed break-words'
            >
              {phrase.join(' ')}
            </div>
            <CopyToClipboard
              text={phrase.join(' ')}
              label={<span className='text-xs text-muted-foreground'>copy to clipboard</span>}
              className='m-auto'
              isSuccessCopyText
            />
          </div>
        )}
      </div>
    </SettingsScreen>
  );
};
