/**
 * Open a screen the way a clicked zafu link does: the intent becomes its
 * link, the links router reads it, and its one landing opens. So a row's
 * action and a link to the same thing can never go to different places.
 */

import { useNavigate } from 'react-router-dom';
import { land } from '../links/land';
import { parseLink, toUri, type Intent } from '../links/router';

export const useOpenIntent = () => {
  const navigate = useNavigate();
  return (intent: Intent) => {
    const to = land(parseLink(toUri(intent)));
    if ('to' in to) {
      navigate(to.to, { state: to.state });
    }
  };
};
