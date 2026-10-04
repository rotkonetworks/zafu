/** "pay with cash": the first row where zec can be paid for, opening the buy page */

import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { BUY_PRELOAD, openBuyPage } from '../buy/open';

export const BuyCashRow = () => (
  <RowGroup>
    <Row
      type='screen'
      media={
        <span className='grid size-6 place-items-center border border-zigner-gold text-xs text-zigner-gold'>
          $
        </span>
      }
      label='cash'
      description='revolut, wise, zelle or monzo'
      preload={BUY_PRELOAD}
      onPress={openBuyPage}
    />
  </RowGroup>
);
