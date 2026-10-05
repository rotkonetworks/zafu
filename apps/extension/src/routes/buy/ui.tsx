/** the buy page's store hook; its column and clock are the scroll pages' own */

import { useStore } from 'zustand';
import { buyStore, type BuyState } from './store';

export { Column, useNow } from '../../components/scroll-page';

export const useBuy = <T,>(sel: (s: BuyState) => T): T => useStore(buyStore, sel);
