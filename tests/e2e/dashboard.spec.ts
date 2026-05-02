import { test, expect, type APIRequestContext } from '@playwright/test';
import type { LoanApplication } from '../../src/models';

const baseApplication = (overrides: Partial<LoanApplication> = {}): LoanApplication => ({
  applicationId: '',
  applicantName: 'E2E Test User',
  ssn: '123-45-6789',
  employerName: 'TestCorp',
  annualIncome: 120000,
  propertyAddress: '123 Test St, Springfield',
  propertyId: 'PROP-E2E',
  loanAmount: 350000,
  downPayment: 70000,
  ...overrides,
});

async function startWorkflow(
  request: APIRequestContext,
  app: LoanApplication
): Promise<string> {
  const res = await request.post('/api/workflows', { data: app });
  expect(res.ok(), await res.text()).toBe(true);
  const body = await res.json();
  return body.workflowId as string;
}

async function getState(request: APIRequestContext, workflowId: string) {
  const res = await request.get(`/api/workflows/${workflowId}`);
  expect(res.ok()).toBe(true);
  return res.json();
}

test('dashboard renders header and stats bar', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Recoverable Activity/);
  await expect(page.getByText('AUSIEX Temporal Demo')).toBeVisible();
  await expect(page.getByText('Total Workflows')).toBeVisible();
  await expect(page.getByText('Pending Fix')).toBeVisible();
  await expect(page.getByText('Rolled Back')).toBeVisible();
});

test('clean workflow appears in the dashboard and reaches CLOSED', async ({
  page,
  request,
}) => {
  const workflowId = await startWorkflow(request, baseApplication());

  await page.goto('/');

  const row = page.locator('tbody tr', { hasText: workflowId });
  await expect(row).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(async () => (await getState(request, workflowId)).state?.status, {
      timeout: 60_000,
      intervals: [500, 1000, 2000],
    })
    .toBe('CLOSED');
});

test('failed workflow can be resolved via Patch and Retry in the UI', async ({
  page,
  request,
}) => {
  const workflowId = await startWorkflow(
    request,
    baseApplication({ ssn: '000-00-0000' })
  );

  // Wait for the workflow to settle into PENDING_FIX before driving the UI
  await expect
    .poll(async () => (await getState(request, workflowId)).state?.status, {
      timeout: 30_000,
      intervals: [500, 1000],
    })
    .toBe('PENDING_FIX');

  await page.goto('/');
  const row = page.locator('tbody tr', { hasText: workflowId });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  const modal = page.locator('.modal-content');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.badge').first()).toContainText('PENDING_FIX');

  // Forward fix section: select ssn, enter corrected value, submit
  const fixSection = modal.locator('.fix-section', { hasText: 'Send Fix via Signal' });
  await fixSection.locator('select').selectOption('ssn');
  await fixSection
    .locator('input[placeholder="Enter corrected value"]')
    .fill('222-33-4444');
  await fixSection.getByRole('button', { name: 'Patch and Retry' }).click();

  // Workflow should reach CLOSED
  await expect
    .poll(async () => (await getState(request, workflowId)).state?.status, {
      timeout: 60_000,
      intervals: [500, 1000, 2000],
    })
    .toBe('CLOSED');

  // The fix should appear in the modal's fix-history table
  await expect(modal.locator('.fix-history').first()).toContainText('ssn');
  await expect(modal.locator('.fix-history').first()).toContainText('222-33-4444');
});

test('cancel signal triggers saga rollback through the UI', async ({
  page,
  request,
}) => {
  // Start a workflow that will pause at title search so we have a deterministic
  // moment to cancel it.
  const workflowId = await startWorkflow(
    request,
    baseApplication({ propertyId: 'MISSING' })
  );

  await expect
    .poll(async () => (await getState(request, workflowId)).state?.status, {
      timeout: 30_000,
      intervals: [500, 1000],
    })
    .toBe('PENDING_FIX');

  await page.goto('/');
  const row = page.locator('tbody tr', { hasText: workflowId });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  const modal = page.locator('.modal-content');
  await expect(modal).toBeVisible();

  await modal.getByRole('button', { name: /Cancel Application/ }).click();
  await modal.locator('input[placeholder^="e.g."]').fill('Applicant withdrew offer');
  await modal.getByRole('button', { name: 'Send Cancellation' }).click();

  await expect
    .poll(async () => (await getState(request, workflowId)).state?.status, {
      timeout: 60_000,
      intervals: [500, 1000, 2000],
    })
    .toBe('ROLLED_BACK');
});
