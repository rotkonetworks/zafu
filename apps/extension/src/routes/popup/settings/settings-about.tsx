import { ExternalLinkIcon } from '@radix-ui/react-icons';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';

export const SettingsAbout = () => {
  return (
    <SettingsScreen title="About" backPath={PopupPath.SETTINGS}>
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-medium mb-1">zafu wallet</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            privacy-first browser wallet for penumbra, zcash, and cosmos IBC chains.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-medium mb-1">networks</h3>
          <ul className="text-xs text-muted-foreground space-y-0.5">
            <li>penumbra — shielded defi</li>
            <li>zcash — orchard shielded pool</li>
            <li>cosmos IBC — osmosis, noble, nomic, celestia</li>
          </ul>
        </div>

        <div>
          <h3 className="text-sm font-medium mb-1">links</h3>
          <div className="flex flex-col gap-1.5">
            <a
              href="https://rotko.net"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <ExternalLinkIcon className="h-3 w-3" />
              rotko.net
            </a>
            <a
              href="https://github.com/nicrotko/zafu"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <ExternalLinkIcon className="h-3 w-3" />
              github
            </a>
            <a
              href="https://zigner.rotko.net"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <ExternalLinkIcon className="h-3 w-3" />
              zigner cold wallet
            </a>
          </div>
        </div>

        <div className="border-t border-border/50 pt-3">
          <p className="text-[10px] text-muted-foreground">
            MIT license — built by rotko networks
          </p>
        </div>
      </div>
    </SettingsScreen>
  );
};
