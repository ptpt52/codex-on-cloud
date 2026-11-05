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
