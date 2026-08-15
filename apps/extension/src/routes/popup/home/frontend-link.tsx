import { useStore } from '../../../state';
import { getDefaultFrontend } from '../../../state/default-frontend';
import { Button } from '@repo/ui/components/ui/button';
import { MouseEventHandler } from 'react';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { DEFAULT_FRONTEND } from '../../page/onboarding/constants';

export const FrontendLink = () => {
  const frontendUrl = useStore(getDefaultFrontend);

  // Append '/portfolio' for the default dex frontend; use the base minifront
  // URL for all others. Compared against DEFAULT_FRONTEND rather than a
  // hardcoded host so moving the default (dex.penumbra.zone -> dex.rotko.net)
  // can't silently drop the deep link.
  const href =
    frontendUrl === DEFAULT_FRONTEND ? new URL('/portfolio', frontendUrl).toString() : frontendUrl;

  const navigate = usePopupNav();

  // In case the frontendUrl is not set, prevent the link action, and open the settings page instead
  const onClick: MouseEventHandler = event => {
    if (frontendUrl) {
      return;
    }
    event.stopPropagation();
    navigate(PopupPath.SETTINGS_DEFAULT_FRONTEND);
  };

  return (
    <a href={href} target='_blank' rel='noreferrer'>
      <Button className='flex w-full items-center gap-2' variant='gradient' onClick={onClick}>
        Manage portfolio {href && <span className='i-ph-arrow-square-out h-4 w-4' />}
      </Button>
    </a>
  );
};
