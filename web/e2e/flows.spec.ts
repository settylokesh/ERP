import { expect, test, type Page } from '@playwright/test';

// Accounts created by server/test/e2e-server.ts and the sample-company fixture.
async function login(page: Page, email = 'admin@example.com', password = 'admin-pass-123') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible();
}

async function pick(page: Page, label: string, text: string) {
  await page.getByRole('combobox', { name: label }).first().click();
  await page.getByRole('textbox', { name: label, exact: true }).fill(text);
  await page.getByRole('option', { name: new RegExp(text) }).first().click();
}

test('sells, invoices with GST and collects payment', async ({ page }) => {
  await login(page);
  await page.goto('/docs/invoice/new');
  await pick(page, 'Customer', 'Sri Lakshmi');
  await pick(page, 'Item', 'Installation');
  await page.getByLabel('Quantity').first().fill('2');
  await expect(page.getByText('Intra-state: CGST + SGST')).toBeVisible();
  await page.getByRole('button', { name: 'Save and Send' }).click();
  await expect(page.getByText('TAX INVOICE')).toBeVisible();
  await expect(page.getByText('Unpaid').first()).toBeVisible();
  await expect(page.getByText('₹2,832.00').first()).toBeVisible();

  const number = (await page.getByRole('heading', { level: 1 }).innerText()).match(/INV-\d+/)![0];
  await page.getByRole('link', { name: 'Record Payment' }).click();
  await expect(page.getByLabel(`Payment for ${number}`)).toHaveValue('2832');
  await page.getByRole('combobox', { name: 'Select an account' }).click();
  await page.getByRole('option', { name: /HDFC Bank/ }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Payment PAY-/)).toBeVisible();
  await page.getByRole('link', { name: number }).click();
  await expect(page.getByText('Paid').first()).toBeVisible();
});

test('journal tab shows a balanced double entry', async ({ page }) => {
  await login(page);
  await page.goto('/docs/invoice');
  await page.locator('tbody tr').first().click();
  await page.getByRole('button', { name: 'Journal' }).click();
  const totals = page.locator('tfoot td.num');
  await expect(totals.nth(0)).toHaveText(await totals.nth(1).innerText());
});

test('balance sheet and trial balance balance', async ({ page }) => {
  await login(page);
  await page.goto('/reports/trial_balance');
  await expect(page.getByText('Trial Balance').first()).toBeVisible();
  await expect(page.getByText('does not balance')).toHaveCount(0);
  await page.goto('/reports/balance_sheet');
  await expect(page.getByText('Total Liabilities & Equity')).toBeVisible();
  await expect(page.getByText('does not balance')).toHaveCount(0);
});

test('creates a customer with GSTIN validation', async ({ page }) => {
  await login(page);
  await page.goto('/customers/new');
  await page.getByLabel('Display Name').fill('Playwright Traders');
  await page.getByLabel('GSTIN').fill('27AAPFU0939F1ZA');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('GSTIN check digit is invalid')).toBeVisible();
  await page.getByLabel('GSTIN').fill('27AAPFU0939F1ZV');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Playwright Traders' })).toBeVisible();
});

test('role permissions hide restricted modules', async ({ page }) => {
  await login(page, 'sales@example.com', 'sample-pass-123');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByText('Sales')).toBeVisible();
  await expect(nav.getByText('People & Payroll')).toHaveCount(0);
  await expect(nav.getByText('Banking')).toHaveCount(0);
});

test('manufacturing: inspect and complete a released order', async ({ page }) => {
  await login(page);
  await page.goto('/manufacturing/orders');
  await page.getByRole('button', { name: 'Confirmed' }).click();
  await page.locator('tbody tr').first().click();
  await page.getByRole('button', { name: 'Raise Inspection' }).click();
  await page.getByRole('button', { name: 'Record result' }).click();
  await expect(page.getByText('Inspection recorded')).toBeVisible();
  await page.getByRole('button', { name: 'Complete', exact: true }).click();
  await page.getByRole('button', { name: 'Complete production' }).click();
  await expect(page.getByText('Manufacturing order completed')).toBeVisible();
  await expect(page.getByText('Completed').first()).toBeVisible();
});

test('sales order → package → shipment via the Create menu', async ({ page }) => {
  await login(page);
  await page.goto('/docs/sales_order/new');
  await pick(page, 'Customer', 'Coastal Irrigation');
  await pick(page, 'Item', 'Ball Bearing');
  await page.getByLabel('Quantity').first().fill('10');
  await page.getByRole('button', { name: 'Save and Confirm' }).click();
  await expect(page.getByText('SALES ORDER', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Package', exact: true }).click();
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText('PACKING SLIP', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mark as Shipped' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark as Shipped' }).click();
  await expect(page.getByText('Shipped').first()).toBeVisible();
  await expect(page.getByText('Shipment', { exact: true })).toBeVisible();
});

test('downloads the e-way bill JSON and records the e-way bill number', async ({ page }) => {
  await login(page);
  await page.goto('/docs/invoice?status=unpaid');
  await page.locator('tbody tr', { hasText: 'Sri Lakshmi' }).first().click();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Download e-way bill JSON' }).click();
  let dlg = page.getByRole('dialog');
  await dlg.getByLabel('Approximate distance (km)').fill('35');
  await dlg.getByLabel('Vehicle number (Part-B)').fill('KA01AB1234');
  const [file] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Download JSON' }).click()]);
  expect(file.suggestedFilename()).toMatch(/^ewaybill_INV-\d+\.json$/);

  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Record e-Way Bill' }).click();
  dlg = page.getByRole('dialog');
  await dlg.getByLabel('e-Way bill number').fill('381000654321');
  await dlg.getByLabel('Approximate distance (km)').fill('420');
  await dlg.getByLabel('Vehicle number (Part-B)').fill('KA01AB1234');
  await dlg.getByRole('button', { name: 'Record e-Way Bill' }).click();
  await expect(page.getByText('381000654321').first()).toBeVisible();
  await expect(page.getByText('420 km')).toBeVisible();
});

test('opens GSTR-3B for the period in the link', async ({ page }) => {
  await login(page);
  await page.goto('/compliance/gstr3b?period=2026-08');
  await expect(page.getByLabel('Return period')).toHaveValue('2026-08');
});

test('categorises a bank statement line', async ({ page }) => {
  await login(page);
  await page.goto('/banking');
  await page.getByText('HDFC Bank Current A/c').click();
  await page.locator('tbody tr', { hasText: 'BANK CHARGES' }).getByRole('button', { name: 'Match / Categorise' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Categorise' }).click();
  await dlg.getByRole('combobox', { name: 'Select an account' }).click();
  await dlg.getByRole('textbox', { name: 'Select an account' }).fill('Bank Fees');
  await page.getByRole('option', { name: /Bank Fees and Charges/ }).click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Categorised')).toBeVisible();
});

test('creates, approves and pays a pay run', async ({ page }) => {
  await login(page);
  await page.goto('/payroll/pay-runs');
  await page.getByRole('button', { name: 'Create Pay Run' }).click();
  await page.getByRole('dialog').locator('input[type=month]').fill('2030-01');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: /January 2030/ })).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Accounting entries')).toBeVisible();
  await page.getByRole('button', { name: 'Record Payment' }).click();
  await page.getByRole('dialog').getByRole('combobox', { name: 'Select an account' }).click();
  await page.getByRole('option', { name: /HDFC Bank/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('Payment recorded')).toBeVisible();
});

test('a user added by an administrator chooses their own password at first sign-in', async ({ page, browser }) => {
  await login(page);
  await page.goto('/settings/users');
  await page.getByRole('button', { name: 'Add user' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name').fill('Store Assistant');
  await dlg.getByLabel('Email').fill('assistant@example.com');
  await dlg.getByLabel('Role').selectOption({ label: 'Warehouse Manager' });
  await dlg.getByLabel(/^Password/).fill('temporary-123');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('assistant@example.com')).toBeVisible();

  const other = await (await browser.newContext()).newPage();
  await other.goto('/login');
  await other.getByLabel('Email').fill('assistant@example.com');
  await other.getByLabel('Password').fill('temporary-123');
  await other.getByRole('button', { name: 'Sign in' }).click();
  await expect(other.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await other.getByLabel('Current password').fill('temporary-123');
  await other.getByLabel(/^New password/).fill('my-own-pass-1');
  await other.getByLabel('Confirm new password').fill('my-own-pass-1');
  await other.getByRole('button', { name: 'Change password' }).click();
  await expect(other.getByRole('heading', { name: /^Hello/ })).toBeVisible();
});
