import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';

/** stable empty list so memo/effect deps don't churn while balances load */
export const EMPTY_BALANCES: BalancesResponse[] = [];
