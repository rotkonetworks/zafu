/** "pay with cash": the first row where zec can be paid for, opening the buy page */

import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { PAY_APPS } from '../buy/apps';
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
      description={`${PAY_APPS.filter(a => !a.off)
        .map(a => a.name)
        .join(', ')} · opens the buy page`}
      preload={BUY_PRELOAD}
      onPress={openBuyPage}
    />
  </RowGroup>
);
