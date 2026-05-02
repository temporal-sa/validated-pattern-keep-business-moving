import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { WorkflowHandle } from '@temporalio/client';
import {
  homeLoanWorkflow,
  retrySignal,
  cancelSignal,
  getStateQuery,
} from '../../src/workflows';
import * as activities from '../../src/activities';
import type { LoanApplication, LoanState, LoanStatus } from '../../src/models';

const TASK_QUEUE = 'recoverable-activity-test';

const baseApplication = (overrides: Partial<LoanApplication> = {}): LoanApplication => ({
  applicationId: 'TEST-LOAN-001',
  applicantName: 'Test User',
  ssn: '123-45-6789',
  employerName: 'Acme Corp',
  annualIncome: 120000,
  propertyAddress: '123 Oak St, Springfield',
  propertyId: 'PROP-1',
  loanAmount: 350000,
  downPayment: 70000,
  ...overrides,
});

async function waitForStatus(
  handle: WorkflowHandle,
  predicate: (s: LoanStatus) => boolean,
  timeoutMs = 15_000
): Promise<LoanState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = (await handle.query(getStateQuery)) as LoanState;
      if (predicate(state.status)) return state;
    } catch {
      // workflow may not be queryable yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for matching workflow status`);
}

describe('homeLoanWorkflow', () => {
  let testEnv: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRunPromise: Promise<void>;

  beforeAll(async () => {
    // The time-skipping test server rejects upsertSearchAttributes for keys it
    // doesn't know about, so use the local dev server and register the keys
    // the workflow upserts.
    testEnv = await TestWorkflowEnvironment.createLocal({
      server: {
        extraArgs: [
          '--search-attribute',
          'LoanStatus=Keyword',
          '--search-attribute',
          'FailedActivity=Keyword',
        ],
      },
    });

    worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve('../../src/workflows'),
      activities,
    });
    workerRunPromise = worker.run();
  }, 120_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRunPromise?.catch(() => undefined);
    await testEnv?.teardown();
  });

  it('completes the happy path through all six activities', async () => {
    const result = await testEnv.client.workflow.execute(homeLoanWorkflow, {
      args: [baseApplication({ applicationId: 'TEST-happy' })],
      workflowId: 'TEST-happy',
      taskQueue: TASK_QUEUE,
    });
    expect(result.status).toBe('CLOSED');
    expect(result.completedActivities).toEqual([
      'verifyIncome',
      'runCreditCheck',
      'orderAppraisal',
      'performTitleSearch',
      'underwrite',
      'closeLoan',
    ]);
    expect(result.compensatedActivities).toHaveLength(0);
    expect(result.fixHistory).toHaveLength(0);
  });

  it('pauses at PENDING_FIX on bad SSN and resumes after retry signal with patch', async () => {
    const handle = await testEnv.client.workflow.start(homeLoanWorkflow, {
      args: [
        baseApplication({
          applicationId: 'TEST-fix',
          ssn: '000-00-0000',
        }),
      ],
      workflowId: 'TEST-fix',
      taskQueue: TASK_QUEUE,
    });

    const paused = await waitForStatus(handle, (s) => s === 'PENDING_FIX');
    expect(paused.failedActivity).toBe('runCreditCheck');
    expect(paused.failureMessage).toMatch(/Invalid SSN/);

    await handle.signal(retrySignal, { key: 'ssn', value: '222-33-4444' });
    const result = await handle.result();

    expect(result.status).toBe('CLOSED');
    expect(result.application.ssn).toBe('222-33-4444');
    expect(result.fixHistory).toHaveLength(1);
    expect(result.fixHistory[0]).toMatchObject({
      activity: 'runCreditCheck',
      field: 'ssn',
      oldValue: '000-00-0000',
      newValue: '222-33-4444',
    });
  });

  it('rolls back via saga on OFAC hit at underwrite', async () => {
    const result = await testEnv.client.workflow.execute(homeLoanWorkflow, {
      args: [
        baseApplication({
          applicationId: 'TEST-ofac',
          ssn: '999-12-3456',
        }),
      ],
      workflowId: 'TEST-ofac',
      taskQueue: TASK_QUEUE,
    });

    expect(result.status).toBe('ROLLED_BACK');
    expect(result.cancelReason).toMatch(/OFAC/);
    expect(result.compensatedActivities).toEqual(
      expect.arrayContaining([
        'runCreditCheck',
        'orderAppraisal',
        'performTitleSearch',
      ])
    );
    // verifyIncome has no compensation registered
    expect(result.compensatedActivities).not.toContain('verifyIncome');
    // underwrite never completed forward, so no compensation
    expect(result.compensatedActivities).not.toContain('underwrite');
    expect(result.notificationMessage).toMatch(/Cancellation notice sent/);
  });

  it('triggers saga unwind when cancelApplication signal arrives mid-pipeline', async () => {
    const handle = await testEnv.client.workflow.start(homeLoanWorkflow, {
      args: [
        baseApplication({
          applicationId: 'TEST-cancel',
          // Force pause at title search so we can cancel deterministically
          propertyId: 'MISSING',
        }),
      ],
      workflowId: 'TEST-cancel',
      taskQueue: TASK_QUEUE,
    });

    await waitForStatus(handle, (s) => s === 'PENDING_FIX');
    await handle.signal(cancelSignal, { reason: 'Applicant withdrew offer' });
    const result = await handle.result();

    expect(result.status).toBe('ROLLED_BACK');
    expect(result.cancelReason).toBe('Applicant withdrew offer');
    expect(result.compensatedActivities).toEqual(
      expect.arrayContaining(['runCreditCheck', 'orderAppraisal'])
    );
  });

  it('pauses at ROLLBACK_PENDING_FIX when a compensation fails and resumes after patch', async () => {
    const handle = await testEnv.client.workflow.start(homeLoanWorkflow, {
      args: [
        baseApplication({
          applicationId: 'TEST-rollback-fix',
          ssn: '999-77-8888', // OFAC -> rollback
          propertyAddress: 'APPRAISER_OFFLINE 42 Ridge Dr', // cancelAppraisal will fail
        }),
      ],
      workflowId: 'TEST-rollback-fix',
      taskQueue: TASK_QUEUE,
    });

    const stuck = await waitForStatus(
      handle,
      (s) => s === 'ROLLBACK_PENDING_FIX'
    );
    expect(stuck.failedActivity).toBe('orderAppraisal');

    await handle.signal(retrySignal, {
      key: 'propertyAddress',
      value: '42 Ridge Dr',
    });
    const result = await handle.result();

    expect(result.status).toBe('ROLLED_BACK');
    expect(result.compensatedActivities).toEqual(
      expect.arrayContaining([
        'runCreditCheck',
        'orderAppraisal',
        'performTitleSearch',
      ])
    );
    expect(result.application.propertyAddress).toBe('42 Ridge Dr');
  });
});
