import { expect, test, type Page } from '@playwright/test';

/** Wait until the app shell (first sync done, Inbox rendered) is ready. */
async function openInbox(page: Page) {
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible({ timeout: 30_000 });
}

/** Pretend to be another OS: shortcut labels and the `mod` key follow navigator.platform. */
async function emulatePlatform(page: Page, platform: 'Win32' | 'MacIntel') {
  await page.addInitScript((p) => Object.defineProperty(Navigator.prototype, 'platform', { get: () => p }), platform);
}

const shortcutsDialog = (page: Page) => page.getByRole('dialog', { name: 'Keyboard shortcuts' });

test.describe('keyboard shortcuts overlay', () => {
  test('opens from the profile menu, traps focus, closes on Escape and returns focus', async ({ page }) => {
    await openInbox(page);
    const trigger = page.getByRole('button', { name: 'Account menu' }).first();
    await trigger.click();
    await page.getByRole('menuitem', { name: /Keyboard shortcuts/ }).click();
    const dialog = shortcutsDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('searchbox', { name: 'Filter shortcuts' })).toBeFocused();
    for (const heading of ['Navigation', 'Creation', 'Editing', 'Selection', 'Application']) {
      await expect(dialog.getByRole('heading', { name: heading })).toBeVisible();
    }
    // Features that don't exist yet are not advertised.
    await expect(dialog.getByText('Talk — add tasks by voice')).toHaveCount(0);
    await expect(dialog.getByText('Go to Meetings')).toHaveCount(0);

    // Focus stays inside the modal.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.screenshot({ path: 'test-results/shortcuts-overlay.png' });

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('opens with ? and with Ctrl+/ (same component), filters, shows Ctrl labels on Windows', async ({ page }) => {
    await emulatePlatform(page, 'Win32');
    await openInbox(page);
    await page.locator('body').press('?');
    const dialog = shortcutsDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('searchbox')).toHaveValue(''); // the "?" isn't typed into the filter
    await expect(dialog.locator('[role="img"][aria-label="Control K"]').first()).toBeVisible();
    await dialog.getByRole('searchbox').fill('sidebar');
    await expect(dialog.getByRole('listitem')).toHaveCount(1);
    await expect(dialog.getByRole('listitem')).toContainText('Toggle sidebar');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.keyboard.press('Control+/');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('data-testid', 'shortcuts-dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('clicking outside closes it', async ({ page }) => {
    await openInbox(page);
    await page.locator('body').press('?');
    await expect(shortcutsDialog(page)).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(shortcutsDialog(page)).toBeHidden();
  });

  test('is usable at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await openInbox(page);
    await page.locator('body').press('?');
    const dialog = shortcutsDialog(page);
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.screenshot({ path: 'test-results/shortcuts-overlay-mobile.png' });
  });
});

test.describe('macOS labels', () => {
  test('uses ⌘ and binds Cmd+/', async ({ page }) => {
    await emulatePlatform(page, 'MacIntel');
    await openInbox(page);
    await page.keyboard.press('Meta+/');
    const dialog = shortcutsDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[role="img"][aria-label="Command K"]').first()).toBeVisible();
    await expect(dialog.getByText('⌘').first()).toBeVisible();
    await expect(dialog.getByText('Ctrl', { exact: true })).toHaveCount(0);
  });
});

test.describe('command palette', () => {
  test('exposes New task, New list, Quick capture and Keyboard shortcuts', async ({ page }) => {
    await emulatePlatform(page, 'Win32');
    await openInbox(page);
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    for (const name of ['New task', 'New list', 'Quick capture', 'Keyboard shortcuts']) {
      await expect(palette.getByRole('option', { name: new RegExp(name) })).toBeVisible();
    }
    await palette.getByRole('option', { name: /Keyboard shortcuts/ }).click();
    await expect(shortcutsDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+k');
    await palette.getByRole('option', { name: /Quick capture/ }).click();
    await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+k');
    await palette.getByRole('option', { name: /New list/ }).click();
    await page.waitForURL(/\/list\?id=.+&new=1/);
  });
});

test.describe('in-app capture', () => {
  test('previews parsed metadata and saves exactly one task on repeated Enter', async ({ page }) => {
    await openInbox(page);
    const title = `Submit CS project ${Date.now()}`;
    await page.locator('body').press('n');
    const dialog = page.getByRole('dialog', { name: 'New task' });
    const input = dialog.getByRole('textbox', { name: 'New task' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(''); // the "n" that opened it isn't typed into it
    await input.fill(`${title} tomorrow at 7pm #school`);
    await expect(dialog.getByTestId('capture-chip-due')).toContainText(/Tomorrow, \w{3} \d+ · (7pm|19:00)/);
    await expect(dialog.getByTestId('capture-chip-label')).toContainText('school (new)');
    await page.screenshot({ path: 'test-results/new-task-dialog.png' });
    await input.press('Enter');
    await input.press('Enter').catch(() => undefined);
    await input.press('Enter').catch(() => undefined);
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('main').getByText(title, { exact: true })).toHaveCount(1);
  });
});

test.describe('Quick Capture window (/capture)', () => {
  test('captures into the shared outbox; the main window shows it at once, online and offline, exactly once', async ({ page, context }) => {
    await openInbox(page);
    const capture = await context.newPage();
    await capture.setViewportSize({ width: 560, height: 320 });
    await capture.goto('/capture');
    const input = capture.getByRole('textbox', { name: 'Task' });
    await expect(input).toBeFocused({ timeout: 20_000 });
    await expect(capture.getByRole('heading', { name: 'New task' })).toBeVisible();

    // Online.
    const first = `Call Sarah ${Date.now()}`;
    await input.fill(`${first} next Friday #work`);
    await expect(capture.getByTestId('capture-chip-due')).toContainText(/^.*Friday, \w{3} \d+/);
    await expect(capture.getByTestId('capture-chip-label')).toContainText('work');
    await expect(capture.getByTestId('capture-chip-destination')).toContainText('Inbox');
    await capture.screenshot({ path: 'test-results/quick-capture-window.png' });
    await input.press('Enter');
    await input.press('Enter');
    await expect(capture.getByRole('button', { name: /Added/ })).toBeVisible();
    await expect(page.getByRole('main').getByText(first, { exact: true })).toHaveCount(1, { timeout: 10_000 });

    // Offline: still captured, shown immediately, synced once on reconnect.
    await context.setOffline(true);
    await capture.bringToFront();
    await expect(input).toBeEnabled({ timeout: 5_000 });
    const second = `Buy groceries ${Date.now()}`;
    await input.fill(`${second} tomorrow`);
    await expect(capture.getByText(/Offline — saves now, syncs later/)).toBeVisible();
    await input.press('Enter');
    await expect(page.getByRole('main').getByText(second, { exact: true })).toHaveCount(1, { timeout: 10_000 });
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    // After reconnecting and a full reload from the server's truth, still exactly one.
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole('main').getByText(second, { exact: true })).toHaveCount(1);
      await expect(page.getByRole('main').getByText(first, { exact: true })).toHaveCount(1);
    }).toPass({ timeout: 30_000 });
  });

  test('Escape leaves the page untouched in a browser (the desktop shell hides the window)', async ({ page }) => {
    await openInbox(page); // a device that has synced once
    await page.goto('/capture');
    const input = page.getByRole('textbox', { name: 'Task' });
    await expect(input).toBeFocused({ timeout: 20_000 });
    await input.fill('Draft text');
    await page.keyboard.press('Escape');
    await expect(input).toHaveValue('Draft text');
  });
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('Quick Capture on a device that never synced asks to open Orbit first', async ({ browser }) => {
    // Signed in (session present) but an empty local cache: nothing to capture into yet.
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/user.json' });
    const page = await ctx.newPage();
    await page.goto('/capture');
    await expect(page.getByText('Finish setting up Orbit')).toBeVisible({ timeout: 20_000 });
    await ctx.close();
  });

  test('Quick Capture asks to sign in without raw errors', async ({ page }) => {
    await page.goto('/capture');
    await expect(page.getByText('Sign in to Orbit to use Quick Capture')).toBeVisible();
    await expect(page.getByRole('button', { name: /Open Orbit/ })).toBeVisible();
    await expect(page.getByText(/error|unauthori[sz]ed|jwt/i)).toHaveCount(0);
  });
});

test.describe('settings', () => {
  test('Desktop app section explains Quick Capture in the browser; Shortcuts section reuses the reference', async ({ page }) => {
    await page.goto('/settings/desktop');
    await expect(page.getByRole('heading', { name: 'Quick Capture' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Available in the Orbit desktop app for macOS and Windows/)).toBeVisible();
    await page.goto('/settings/shortcuts');
    await expect(page.getByRole('searchbox', { name: 'Filter shortcuts' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Navigation' })).toBeVisible();
  });
});
