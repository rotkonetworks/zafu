import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { ScreenHeader } from '../../components/screen-header';
import { land, viaLine } from '../../links/land';
import { parseLink } from '../../links/router';
import { Footer, Main } from './send/send-ui';
import { PopupPath } from './paths';

/**
 * Every link enters here: a clicked one through the service worker
 * (`?uri=&via=<origin>`, which survives unlock), a pasted, scanned or chat
 * one as route state. It reads the link and hands it to the screen it
 * fills; what zafu can't open gets one calm line.
 */
export const LinkPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { uri?: string; via?: string } | null;
  const params = new URLSearchParams(location.search);
  const via = state?.via ?? params.get('via') ?? undefined;
  // read once: <Navigate> re-navigates whenever its state object changes
  const [landing] = useState(() => land(parseLink(state?.uri ?? params.get('uri') ?? ''), via));
  if ('to' in landing) {
    return <Navigate to={landing.to} state={landing.state} replace />;
  }
  return (
    <div className='flex h-full flex-col'>
      <ScreenHeader title='link' backPath={PopupPath.INDEX} />
      <Main className='items-center justify-center gap-2 text-center'>
        <p className='text-sm text-fg'>{landing.line}</p>
        <p className='text-[11px] text-fg-muted'>{viaLine(via)}</p>
      </Main>
      <Footer>
        <Button variant='secondary' onClick={() => navigate(PopupPath.INDEX)} className='grow'>
          back to wallet
        </Button>
      </Footer>
    </div>
  );
};
