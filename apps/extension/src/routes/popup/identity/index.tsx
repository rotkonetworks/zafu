import { useState } from 'react';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo } from '../../../state/keyring';

export const IdentityPage = () => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const [copied, setCopied] = useState<'address' | 'pubkey' | null>(null);

  const zidPubkey = keyInfo?.insensitive?.['zid'] as string | undefined;
  const zidAddress = zidPubkey ? 'zid' + zidPubkey.slice(0, 16) : undefined;

  const copy = (text: string, which: 'address' | 'pubkey') => {
    void navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  };

  if (!zidPubkey) {
    return (
      <div className='flex min-h-full flex-col items-center justify-center p-8'>
        <span className='i-lucide-fingerprint h-10 w-10 text-muted-foreground/30' />
        <p className='mt-4 text-sm text-muted-foreground text-center'>
          no zid available
        </p>
        <p className='mt-1 text-xs text-muted-foreground/60 text-center'>
          create a new wallet to get a zid identity.
          existing wallets created before this version need to be re-created.
        </p>
      </div>
    );
  }

  return (
    <div className='flex min-h-full flex-col p-4 gap-4'>
      {/* header */}
      <div className='flex items-center gap-2'>
        <span className='i-lucide-fingerprint h-5 w-5 text-muted-foreground' />
        <span className='text-sm font-medium'>zid</span>
      </div>

      {/* zid address  - large, prominent */}
      <button
        onClick={() => copy(zidPubkey, 'address')}
        className='rounded-lg border border-border/40 bg-card p-4 text-left hover:bg-muted/50 transition-colors'
      >
        <div className='text-[10px] text-muted-foreground/60 mb-1'>
          {copied === 'address' ? 'copied to clipboard' : 'tap to copy pubkey'}
        </div>
        <div className='font-mono text-sm break-all leading-relaxed'>
          {zidAddress}
        </div>
      </button>

      {/* full pubkey */}
      <div className='rounded-lg border border-border/40 bg-card p-4'>
        <div className='flex items-center justify-between mb-2'>
          <span className='text-[10px] text-muted-foreground/60'>ed25519 public key</span>
          <button
            onClick={() => copy(zidPubkey, 'pubkey')}
            className='flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors'
          >
            {copied === 'pubkey' ? 'copied' : 'copy'}
            <span className='i-lucide-copy h-3 w-3' />
          </button>
        </div>
        <div className='font-mono text-[10px] text-muted-foreground break-all leading-relaxed select-all'>
          {zidPubkey}
        </div>
      </div>

      {/* info */}
      <div className='rounded-lg border border-border/40 p-3'>
        <p className='text-xs text-muted-foreground leading-relaxed'>
          your zid is a cross-network identity derived from your seed phrase.
          apps can request signatures to verify your identity without
          revealing your wallet addresses or balances.
        </p>
      </div>

      {/* vault name */}
      {keyInfo && (
        <div className='text-[10px] text-muted-foreground/40 text-center'>
          {keyInfo.name} &middot; {keyInfo.type}
        </div>
      )}
    </div>
  );
};
