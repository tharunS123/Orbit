import { expect, test as setup } from '@playwright/test';

/** Sign up a fresh user through the real form (local Supabase has email confirmation off). */
setup('sign up a test user', async ({ page, browser }) => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('E2E Tester');
  await page.getByLabel('Email').fill(`e2e-${id}@orbit.test`);
  await page.getByLabel('Password').fill(`pw-${id}-Aa1!`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/inbox/, { timeout: 30_000 });
  if (page.url().includes('/onboarding')) {
    await page.getByRole('button', { name: 'Skip setup' }).click();
  }
  await page.waitForURL(/\/inbox/, { timeout: 30_000 });
  await expect(page.getByRole('navigation').first()).toBeVisible();
  // Wait until "onboarded" has synced: a fresh browser (empty local cache) must land in the Inbox.
  await expect(async () => {
    await page.context().storageState({ path: 'e2e/.auth/user.json' });
    const fresh = await browser.newContext({ storageState: 'e2e/.auth/user.json' });
    const probe = await fresh.newPage();
    try {
      await probe.goto('/inbox');
      await expect(probe.getByRole('button', { name: 'Account menu' }).first()).toBeVisible({ timeout: 15_000 });
      expect(probe.url()).toContain('/inbox');
    } finally {
      await fresh.close();
    }
  }).toPass({ timeout: 60_000 });
});
