import { ExternalLinkIcon } from '@radix-ui/react-icons';
import { SettingsScreen } from './settings-screen';

export const SettingsAbout = () => {
  return (
    <SettingsScreen title="About">
      <div className="flex flex-col gap-6">
        <div>
          <h3 className="text-sm font-medium mb-2">zafu wallet</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            zafu is a multi-network browser extension wallet supporting privacy-focused
            blockchains like penumbra and zcash alongside polkadot and other networks.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-medium mb-2">history</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            forked from prax wallet (penumbra) with significant modifications to support
            additional networks and hardware wallet integration.
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed mt-2">
            key additions include qr code signing compatibility with zigner, our fork of
            parity's vault (now polkadot vault) mobile app, enabling air-gapped transaction
            signing across multiple networks.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-medium mb-2">networks</h3>
          <ul className="text-xs text-muted-foreground space-y-1">
            <li>• penumbra - shielded defi with private transactions</li>
            <li>• zcash - orchard shielded pool support</li>
            <li>• polkadot / kusama - substrate-based relay chains</li>
            <li>• ethereum & evm - coming soon</li>
            <li>• cosmos / ibc - coming soon</li>
          </ul>
        </div>

        <div>
          <h3 className="text-sm font-medium mb-2">links</h3>
          <div className="flex flex-col gap-2">
            <a
              href="https://rotko.net"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-xs text-primary hover:underline"
            >
              <ExternalLinkIcon className="h-3 w-3" />
              rotko.net
            </a>
            <a
              href="https://github.com/nicrotko/zafu"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-xs text-primary hover:underline"
            >
              <ExternalLinkIcon className="h-3 w-3" />
              github
            </a>
            <a
              href="https://github.com/nicrotko/zigner"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-xs text-primary hover:underline"
            >
              <ExternalLinkIcon className="h-3 w-3" />
              zigner (mobile signer)
            </a>
          </div>
        </div>

        <div className="border-t border-border/50 pt-4">
          <p className="text-xs text-muted-foreground">
            license: mit
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            built by rotko networks
          </p>
        </div>
      </div>
    </SettingsScreen>
  );
};
