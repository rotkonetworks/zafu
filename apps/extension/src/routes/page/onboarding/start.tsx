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
      <div className='flex flex-col items-center gap-8 max-w-lg mx-auto'>
        {/* header */}
        <div className='flex flex-col items-center gap-2 pt-4'>
          <h1 className='bg-text-linear bg-clip-text font-headline text-4xl font-bold text-transparent'>
            zafu
          </h1>
          <p className='text-muted-foreground text-center'>
            privacy wallet for zcash and penumbra
          </p>
        </div>

        {/* get started */}
        <Card className='w-full' gradient>
          <CardHeader className='items-center'>
            <CardTitle>get started</CardTitle>
            <CardDescription className='text-center'>
              your keys stay on your device. always.
            </CardDescription>
          </CardHeader>
          <CardContent className='grid gap-3'>
            <Button
              variant='secondary'
              className='w-full'
              onClick={() => navigate(PagePath.GENERATE_SEED_PHRASE)}
            >
              create new wallet
            </Button>
            <Button
              variant='outline'
              className='w-full'
              onClick={() => navigate(PagePath.IMPORT_SEED_PHRASE)}
            >
              import seed phrase
            </Button>
            <Button
              variant='outline'
              className='w-full'
              onClick={() => navigate(PagePath.IMPORT_ZIGNER)}
            >
              connect zigner (airgap)
            </Button>
          </CardContent>
        </Card>

        {/* info cards */}
        <div className='grid grid-cols-2 gap-3 w-full'>
          <InfoCard
            icon='i-lucide-shield'
            title='shielded transactions'
            text='zcash orchard + penumbra. client-side proving. no third party sees your data.'
          />
          <InfoCard
            icon='i-lucide-fingerprint'
            title='zid identity'
            text='cross-network ed25519 identity derived from your seed. sign in to apps privately.'
          />
          <InfoCard
            icon='i-lucide-users'
            title='FROST multisig'
            text='threshold signing for zcash. coordinate via shielded memos. no coordinator server.'
          />
          <InfoCard
            icon='i-lucide-smartphone'
            title='zigner airgap'
            text='keep spending keys offline. sign transactions via QR codes with your phone.'
          />
        </div>

        {/* links */}
        <div className='flex items-center gap-4 text-xs text-muted-foreground pb-8'>
          <a href='https://rotko.net' target='_blank' rel='noopener noreferrer' className='hover:text-foreground transition-colors'>rotko.net</a>
          <a href='https://github.com/rotkonetworks/zafu' target='_blank' rel='noopener noreferrer' className='hover:text-foreground transition-colors'>source code</a>
          <a href='https://zigner.rotko.net' target='_blank' rel='noopener noreferrer' className='hover:text-foreground transition-colors'>zigner app</a>
          <span className='text-muted-foreground/40'>GPL-3.0</span>
        </div>
      </div>
    </FadeTransition>
  );
};

const InfoCard = ({ icon, title, text }: { icon: string; title: string; text: string }) => (
  <div className='rounded-lg border border-border/40 bg-card p-3'>
    <div className='flex items-center gap-2 mb-1.5'>
      <span className={`${icon} h-4 w-4 text-muted-foreground`} />
      <span className='text-xs font-medium'>{title}</span>
    </div>
    <p className='text-[10px] text-muted-foreground/70 leading-relaxed'>{text}</p>
  </div>
);
