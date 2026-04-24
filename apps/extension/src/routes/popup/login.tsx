import { Button } from '@repo/ui/components/ui/button';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { InputProps } from '@repo/ui/components/ui/input';
import { PasswordInput } from '../../shared/components/password-input';
import { usePopupNav } from '../../utils/navigate';
import { useStore } from '../../state';
import { passwordSelector } from '../../state/password';
import { FormEvent, useState } from 'react';
import { PopupPath } from './paths';
import { needsOnboard } from './popup-needs';

export const popupLoginLoader = () => needsOnboard();

export const Login = () => {
  const navigate = usePopupNav();

  const { isPassword, setSessionPassword } = useStore(passwordSelector);
  const [input, setInputValue] = useState('');
  const [enteredIncorrect, setEnteredIncorrect] = useState(false);

  const handleUnlock = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    void (async function () {
      if (await isPassword(input)) {
        await setSessionPassword(input); // saves to session state
        navigate(PopupPath.INDEX);
      } else {
        setEnteredIncorrect(true);
      }
    })();
  };

  const handleChangePassword: InputProps['onChange'] = e => {
    setInputValue(e.target.value);
    setEnteredIncorrect(false);
  };

  return (
    <FadeTransition className='flex flex-col items-stretch justify-start'>
      <div className='flex h-screen flex-col justify-between p-[30px] pt-10 '>
        <div className='mx-auto my-0 flex flex-col items-center gap-1'>
          <span className='kicker'>privacy wallet</span>
          <h1 className='text-[32px] text-zigner-gold lowercase tracking-[-0.01em] leading-none'>
            zafu
          </h1>
        </div>
        <form onSubmit={handleUnlock} className='grid gap-4'>
          <PasswordInput
            passwordValue={input}
            label={
              <p className='text-[18px] text-fg-high lowercase tracking-[-0.01em]'>
                enter password
              </p>
            }
            onChange={handleChangePassword}
            validations={[
              {
                type: 'error',
                issue: 'wrong password',
                checkFn: () => enteredIncorrect,
              },
            ]}
          />
          <Button size='lg' variant='gradient' disabled={enteredIncorrect} type='submit'>
            Unlock
          </Button>
        </form>
        <div className='flex flex-col gap-1'>
          <p className='text-center text-fg-muted'>
            Need help?{' '}
            <a
              className='cursor-pointer text-teal hover:underline transition-colors'
              href={chrome.runtime.getURL('zitadel.html?room=support')}
              target='_blank'
              rel='noreferrer'
            >
              Chat with us
            </a>
          </p>
          <p className='text-center text-xs text-fg-muted/50'>
            {BUILD_COMMIT}-{BUILD_DATE}
          </p>
        </div>
      </div>
    </FadeTransition>
  );
};
