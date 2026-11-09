import { expect } from '@playwright/test';

export async function openTools(page) {
  if (await page.locator('#toggle-controls-button').getAttribute('aria-expanded') !== 'true') await page.locator('#toggle-controls-button').click();
  await expect(page.locator('#workspace-tools')).toBeVisible();
}

export async function openInput(page) {
  if (await page.locator('#toggle-input-button').getAttribute('aria-expanded') !== 'true') await page.locator('#toggle-input-button').click();
  await expect(page.locator('#input-dock')).toBeVisible();
}

export async function closePanels(page) {
  if (await page.locator('#toggle-input-button').getAttribute('aria-expanded') === 'true') await page.locator('#close-input-button').click();
  if (await page.locator('#toggle-controls-button').getAttribute('aria-expanded') === 'true') await page.locator('#close-controls-button').click();
}

export async function waitForTerminalLayout(page) {
  // A catalog update replaces the tab nodes before the next animation frame
  // assigns overflow entries to the picker. Text alone is not readiness.
  await expect.poll(() => page.locator('#terminal-tabs').evaluate(tabs =>
    !tabs.getClientRects().length || tabs.scrollWidth <= tabs.clientWidth + 1)).toBe(true);
}
