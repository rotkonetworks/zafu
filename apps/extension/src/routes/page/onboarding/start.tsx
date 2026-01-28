import { Button } from '@repo/ui/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@repo/ui/components/ui/card';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';

export const OnboardingStart = () => {
  const navigate = usePageNav();

  return (
    <FadeTransition>
      <div className='mb-5 flex flex-col items-center gap-2'>
        <h1 className='bg-text-linear bg-clip-text font-headline text-4xl font-bold text-transparent'>
          Zafu
        </h1>
        <p className='text-muted-foreground'>Privacy-first multi-chain wallet</p>
      </div>
      <Card className='w-[400px] ' gradient>
        <CardHeader className='items-center'>
          <CardTitle>Your Keys, Your Privacy</CardTitle>
          <CardDescription className='text-center'>
            Securely transact across Penumbra, Zcash, and more privacy-focused networks.
            Your keys never leave your device.
          </CardDescription>
        </CardHeader>
        <CardContent className='mt-6 grid gap-4'>
          <Button
            variant='gradient'
            className='w-full'
            onClick={() => navigate(PagePath.GENERATE_SEED_PHRASE)}
          >
            Create new wallet
          </Button>
          <Button
            variant='secondary'
            className='w-full'
            onClick={() => navigate(PagePath.IMPORT_SEED_PHRASE)}
          >
            Import existing wallet
          </Button>
          <Button
            variant='outline'
            className='w-full'
            onClick={() => navigate(PagePath.IMPORT_ZIGNER)}
          >
Connect Zafu Zigner (watch-only)
          </Button>
        </CardContent>
      </Card>
    </FadeTransition>
  );
};
