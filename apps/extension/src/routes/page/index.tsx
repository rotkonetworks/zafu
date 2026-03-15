import { redirect } from 'react-router-dom';
import { PagePath } from './paths';
import { SplashPage } from '@repo/ui/components/ui/splash-page';
import { Button } from '@repo/ui/components/ui/button';
import { localExtStorage } from '@repo/storage-chrome/local';

// Because Zustand initializes default empty (prior to persisted storage synced),
// We need to manually check storage for accounts in the loader.
// Will redirect to onboarding if necessary.
export const pageIndexLoader = async () => {
  const wallets = await localExtStorage.get('wallets');

  if (!wallets.length) {
    return redirect(PagePath.WELCOME);
  }

  return null;
};

export const PageIndex = () => {
  return (
    <SplashPage
      title='wallet ready'
      description='you can close this tab and use zafu from the browser toolbar.'
    >
      <Button
        variant='secondary'
        className='w-full'
        onClick={() => window.close()}
      >
        close
      </Button>
    </SplashPage>
  );
};
