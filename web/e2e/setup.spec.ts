import { expect, test } from '@playwright/test';

// Runs against a second server started with an empty database (see playwright.config.ts).
test.use({ baseURL: 'http://localhost:4101' });

test('first-run setup creates the organisation and administrator', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Set up your organisation' })).toBeVisible();
  await page.getByLabel(/^Setup code/).fill('E2E-SETUP-CODE');
  await page.getByLabel(/^Organisation name/).fill('Asha Textiles');
  await page.getByLabel(/^State/).selectOption('33');
  await page.getByLabel(/^City/).fill('Tiruppur');
  await page.getByLabel('Your name').fill('Asha');
  await page.getByLabel(/^Email/).fill('owner@ashatextiles.example');
  await page.getByLabel(/^Password/).fill('asha-pass-2026');
  await page.getByLabel('Confirm password').fill('asha-pass-2026');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible();
  // Setup cannot be run again.
  await page.goto('/setup');
  await expect(page).toHaveURL(/\/login$|\/$/);
});
