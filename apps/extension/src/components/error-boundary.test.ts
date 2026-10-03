import { describe, expect, it } from 'vitest';
import { isApprovalHash } from './error-boundary';
import { APPROVAL_ROUTES, PopupPath } from '../routes/popup/paths';

describe('crash screen on an approval window', () => {
  it('recognises every real approval path, with or without a query', () => {
    for (const route of APPROVAL_ROUTES) {
      expect(isApprovalHash(`#${route}`), route).toBe(true);
      expect(isApprovalHash(`#${route}?requestId=abc`), route).toBe(true);
    }
    expect(isApprovalHash(`#${PopupPath.TRANSACTION_APPROVAL}`)).toBe(true);
  });

  it('offers "begin again" everywhere else', () => {
    expect(isApprovalHash('')).toBe(false);
    expect(isApprovalHash('#/')).toBe(false);
    expect(isApprovalHash(`#${PopupPath.LOGIN}`)).toBe(false);
    expect(isApprovalHash('#/approval-tx-lookalike')).toBe(false);
  });
});
