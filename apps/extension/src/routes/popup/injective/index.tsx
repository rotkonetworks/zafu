/**
 * The old Injective screen's route. Receiving is on Receive and moving funds
 * is the regular send form now; this keeps old deep links and the
 * `zafu_open_shield` dapp hand-off landing on "shield from Injective".
 */

import { Navigate } from 'react-router-dom';
import { PopupPath } from '../paths';

export const InjectivePage = () => (
  <Navigate
    to={PopupPath.SEND}
    replace
    state={{ cosmosChain: 'injective', cosmosIntent: 'shield' }}
  />
);

export default InjectivePage;
