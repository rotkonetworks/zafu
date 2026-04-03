/**
 * connected sites — redirects to identity page where all site management lives.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PopupPath } from '../../paths';

export const SettingsConnectedSites = () => {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(PopupPath.IDENTITY, { replace: true });
  }, [navigate]);
  return null;
};
