import { ApplicationFailure } from '@temporalio/activity';
import * as activities from '../../src/activities';

describe('verifyIncome', () => {
  it('returns success message for valid input', async () => {
    const result = await activities.verifyIncome('Alice', 'Acme Corp', 120000);
    expect(result).toContain('Alice');
    expect(result).toContain('120000');
    expect(result).toContain('Acme Corp');
  });

  it('throws non-retryable failure for UNKNOWN_EMPLOYER', async () => {
    await expect(
      activities.verifyIncome('Alice', 'UNKNOWN_EMPLOYER', 120000)
    ).rejects.toThrow(ApplicationFailure);
  });

  it('throws for non-positive income', async () => {
    await expect(
      activities.verifyIncome('Alice', 'Acme Corp', 0)
    ).rejects.toThrow(/Invalid annual income/);
  });
});

describe('runCreditCheck', () => {
  it('passes for valid SSN', async () => {
    const result = await activities.runCreditCheck('Alice', '123-45-6789');
    expect(result).toContain('Alice');
    expect(result).toContain('750');
  });

  it('rejects all-zero SSN', async () => {
    await expect(
      activities.runCreditCheck('Alice', '000-00-0000')
    ).rejects.toThrow(/Invalid SSN/);
  });

  it('rejects short SSN', async () => {
    await expect(
      activities.runCreditCheck('Alice', '123')
    ).rejects.toThrow(/Invalid SSN/);
  });
});

describe('orderAppraisal', () => {
  it('returns success for a valid address', async () => {
    const result = await activities.orderAppraisal('123 Oak St', 300000);
    expect(result).toContain('123 Oak St');
    expect(result).toContain(`${300000 * 1.1}`);
  });

  it.each([['INVALID_ADDRESS'], ['']])(
    'rejects bad address %p',
    async (addr) => {
      await expect(activities.orderAppraisal(addr, 300000)).rejects.toThrow(
        /invalid property address/
      );
    }
  );
});

describe('performTitleSearch', () => {
  it('returns success for a valid property', async () => {
    const result = await activities.performTitleSearch('PROP-1', '123 Oak St');
    expect(result).toContain('PROP-1');
    expect(result).toContain('123 Oak St');
  });

  it.each([['MISSING'], ['']])('rejects bad property id %p', async (id) => {
    await expect(
      activities.performTitleSearch(id, '123 Oak St')
    ).rejects.toThrow(/Title search failed/);
  });
});

describe('underwrite', () => {
  it('approves reasonable DTI', async () => {
    const result = await activities.underwrite(
      'Alice',
      '123-45-6789',
      120000,
      350000,
      70000
    );
    expect(result).toContain('Underwriting approved');
  });

  it('flags OFAC hit as RollbackRequired', async () => {
    let caught: any;
    try {
      await activities.underwrite('Bad', '999-12-3456', 100000, 200000, 40000);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApplicationFailure);
    expect(caught.type).toBe('RollbackRequired');
  });

  it('rejects DTI over 400%', async () => {
    await expect(
      activities.underwrite('Eve', '111-22-3333', 45000, 500000, 10000)
    ).rejects.toThrow(/exceeds 400%/);
  });
});

describe('closeLoan', () => {
  it('returns success message', async () => {
    const result = await activities.closeLoan('LOAN-1', 'Alice', 350000);
    expect(result).toContain('LOAN-1');
    expect(result).toContain('Alice');
    expect(result).toContain('350000');
  });
});

describe('compensation activities', () => {
  it('withdrawCreditInquiry returns idempotent message', async () => {
    const result = await activities.withdrawCreditInquiry('LOAN-1', '123-45-6789');
    expect(result).toContain('LOAN-1');
    expect(result).toContain('6789');
  });

  it('cancelAppraisal succeeds for normal address', async () => {
    const result = await activities.cancelAppraisal('LOAN-1', '123 Oak St');
    expect(result).toContain('LOAN-1');
  });

  it('cancelAppraisal fails when vendor offline', async () => {
    await expect(
      activities.cancelAppraisal('LOAN-1', 'APPRAISER_OFFLINE 42 Ridge Dr')
    ).rejects.toThrow(/vendor unreachable/);
  });

  it('releaseTitleHold succeeds for normal property', async () => {
    const result = await activities.releaseTitleHold('LOAN-1', 'PROP-1');
    expect(result).toContain('LOAN-1');
    expect(result).toContain('PROP-1');
  });

  it('releaseTitleHold fails for locked title', async () => {
    await expect(
      activities.releaseTitleHold('LOAN-1', 'LOCKED_TITLE')
    ).rejects.toThrow(/rejected release/);
  });

  it('releaseUnderwritingReservation returns success', async () => {
    const result = await activities.releaseUnderwritingReservation('LOAN-1', 350000);
    expect(result).toContain('LOAN-1');
    expect(result).toContain('350000');
  });

  it('reverseLoanClosure returns success', async () => {
    const result = await activities.reverseLoanClosure('LOAN-1', 350000);
    expect(result).toContain('LOAN-1');
    expect(result).toContain('350000');
  });

  it('notifyApplicantCancelled returns success', async () => {
    const result = await activities.notifyApplicantCancelled(
      'LOAN-1',
      'Alice',
      'Applicant withdrew'
    );
    expect(result).toContain('Alice');
    expect(result).toContain('Applicant withdrew');
  });
});
