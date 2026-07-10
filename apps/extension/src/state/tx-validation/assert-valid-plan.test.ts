/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- test file */
import { ActionPlan } from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import type { Address } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import type { FullViewingKey } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { generateSpendKey, getAddressByIndex, getFullViewingKey } from '@rotko/penumbra-wasm/keys';
import { describe, expect, it } from 'vitest';
import { assertValidActionPlans } from './assert-valid-plan.js';

const currentUserSeedPhrase =
  'benefit cherry cannon tooth exhibit law avocado spare tooth that amount pumpkin scene foil tape mobile shine apology add crouch situate sun business explain';

const otherUserSeedPhrase =
  'cancel tilt shallow way roast utility profit satoshi mushroom seek shift helmet';

// top-level await: `it.each` reads these during collection, before any
// beforeAll hook would run
const currentUserFullViewingKey: FullViewingKey = await getFullViewingKey(
  await generateSpendKey(currentUserSeedPhrase),
);
const currentUserAddress: Address = await getAddressByIndex(currentUserFullViewingKey, 1);

const otherUserAddress: Address = await getAddressByIndex(
  await getFullViewingKey(await generateSpendKey(otherUserSeedPhrase)),
  1,
);

describe('individual plans', () => {
  it('rejects an empty action plan', async () => {
    const emptyActionPlan = new ActionPlan({});
    await expect(
      assertValidActionPlans([emptyActionPlan], currentUserFullViewingKey),
    ).rejects.toThrow('Missing action plan');
  });

  it('rejects an action missing a value', async () => {
    const planMissingValue = new ActionPlan({});
    planMissingValue.action.case = 'spend';
    await expect(
      assertValidActionPlans([planMissingValue], currentUserFullViewingKey),
    ).rejects.toThrow('Missing action plan');
  });

  it('rejects an action missing a case', async () => {
    const planMissingCase = new ActionPlan({});
    planMissingCase.action.value = { something: 'with a value' } as any;
    planMissingCase.action.case = undefined;

    await expect(
      assertValidActionPlans([planMissingCase], currentUserFullViewingKey),
    ).rejects.toThrow('Unknown action plan');
  });

  it('rejects an action with some unknown case', async () => {
    const planUnknownCase = new ActionPlan({});
    planUnknownCase.action.value = { something: 'with a value' } as any;
    planUnknownCase.action.case = 'notValid' as ActionPlan['action']['case'];
    await expect(
      assertValidActionPlans([planUnknownCase], currentUserFullViewingKey),
    ).rejects.toThrow('Unknown action plan');
  });

  describe('swap actions', () => {
    it('does not reject when the swap claim address is controlled', async () => {
      const swapWithCurrentUserAddress = new ActionPlan({
        action: {
          case: 'swap',
          value: {
            swapPlaintext: { claimAddress: currentUserAddress },
          },
        },
      });

      await expect(
        assertValidActionPlans([swapWithCurrentUserAddress], currentUserFullViewingKey),
      ).resolves.toBeUndefined();
    });

    it('rejects when the swap claim address is not controlled', async () => {
      const swapWithOtherUserAddress = new ActionPlan({
        action: {
          case: 'swap',
          value: {
            swapPlaintext: { claimAddress: otherUserAddress },
          },
        },
      });
      await expect(
        assertValidActionPlans([swapWithOtherUserAddress], currentUserFullViewingKey),
      ).rejects.toThrow('uncontrolled claim address');
    });

    it('rejects when the swap claim address is undefined', async () => {
      const swapWithUndefinedAddress = new ActionPlan({
        action: {
          case: 'swap',
          value: {
            swapPlaintext: {},
          },
        },
      });
      await expect(
        assertValidActionPlans([swapWithUndefinedAddress], currentUserFullViewingKey),
      ).rejects.toThrow('missing claim address');
    });

    it('rejects when the swap claim address is all zeroes', async () => {
      const swapWithWrongLengthClaimAddress = new ActionPlan({
        action: {
          case: 'swap',
          value: {
            swapPlaintext: {
              claimAddress: { inner: new Uint8Array(80).fill(0) },
            },
          },
        },
      });

      await expect(
        assertValidActionPlans([swapWithWrongLengthClaimAddress], currentUserFullViewingKey),
      ).rejects.toThrow('missing claim address');
    });
  });

  describe('swapClaim actions', () => {
    it('rejects swapClaim actions which do not require authorization', async () => {
      const swapClaimAction = new ActionPlan({
        action: {
          case: 'swapClaim',
          value: {},
        },
      });

      await expect(
        assertValidActionPlans([swapClaimAction], currentUserFullViewingKey),
      ).rejects.toThrow('does not require authorization');
    });
  });

  describe('output actions', () => {
    it.each([undefined, 0, 1, 80, 81])(
      `rejects when the output destination address is %s zeroes`,
      async innerLength => {
        const destAddress =
          innerLength == null ? undefined : { inner: new Uint8Array(innerLength) };
        await expect(
          assertValidActionPlans(
            [
              new ActionPlan({
                action: {
                  case: 'output',
                  value: { destAddress },
                },
              }),
            ],
            currentUserFullViewingKey,
          ),
        ).rejects.toThrow('missing destination address');
      },
    );

    it.each([
      { inner: currentUserAddress.inner.slice(1) },
      { inner: Uint8Array.from([...currentUserAddress.inner, 81]) },
    ])('rejects when the output destination address is invalid', async destAddress => {
      await expect(
        assertValidActionPlans(
          [
            new ActionPlan({
              action: {
                case: 'output',
                value: { destAddress },
              },
            }),
          ],
          currentUserFullViewingKey,
        ),
      ).rejects.toThrow('invalid destination address');
    });

    it('does not reject when the output destination address is nonzero', async () => {
      const outputWithValidDestination = new ActionPlan({
        action: {
          case: 'output',
          value: {
            destAddress: { inner: new Uint8Array(80).fill(3) },
          },
        },
      });

      await expect(
        assertValidActionPlans([outputWithValidDestination], currentUserFullViewingKey),
      ).resolves.toBeUndefined();
    });
  });
});

describe('lists of plans', () => {
  it('rejects when no actions are provided', async () => {
    await expect(assertValidActionPlans([], currentUserFullViewingKey)).rejects.toThrow(
      'No actions planned',
    );
    await expect(assertValidActionPlans(undefined, currentUserFullViewingKey)).rejects.toThrow(
      'No actions planned',
    );
  });

  it('validates all actions', async () => {
    await expect(
      assertValidActionPlans(
        [
          new ActionPlan({
            action: {
              case: 'spend',
              value: {},
            },
          }),
          new ActionPlan({
            action: {
              case: 'delegate',
              value: {},
            },
          }),
        ],
        currentUserFullViewingKey,
      ),
    ).resolves.toBeUndefined();

    await expect(
      assertValidActionPlans(
        [
          new ActionPlan({
            action: {
              case: 'spend',
              value: {},
            },
          }),
          new ActionPlan({
            action: {
              case: 'output',
              value: { destAddress: otherUserAddress },
            },
          }),
          new ActionPlan({
            action: {
              case: 'swap',
              value: {
                swapPlaintext: { claimAddress: otherUserAddress },
              },
            },
          }),
        ],
        currentUserFullViewingKey,
      ),
    ).rejects.toThrow('uncontrolled claim address');
  });
});
