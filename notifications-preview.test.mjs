import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Run with: node notifications-preview.test.mjs
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(new URL('./notifications-preview.html', import.meta.url).href);
  assert.equal(await page.locator('#notification').isVisible(), true);
  await page.getByRole('radio', { name: 'Notch', exact: true }).check();
  assert.match(await page.locator('#notification').getAttribute('class'), /notch/);
  await page.locator('#sound').uncheck();
  await page.getByRole('button', { name: 'Testar notificação' }).click();
  assert.match(await page.locator('#status').textContent(), /Teste:/);
  await page.locator('#example').selectOption('done');
  assert.equal(await page.locator('#notification-title').textContent(), 'Pronto para sua revisão.');
  await page.locator('.event[value="done"]').uncheck();
  assert.equal(await page.locator('#test').isDisabled(), true);
  await page.locator('.event[value="done"]').check();
  await page.getByRole('radio', { name: 'Sem visual', exact: true }).check();
  assert.equal(await page.locator('#notification').isVisible(), false);
  assert.equal(await page.locator('#test').isDisabled(), true);
  await page.locator('#sound').check();
  assert.equal(await page.locator('#test').isEnabled(), true);
  await page.locator('#mac').uncheck();
  assert.equal(await page.locator('#sound').isDisabled(), true);
  assert.equal(await page.locator('#phone-toggle').isEnabled(), true);
  await page.locator('#enabled').uncheck();
  assert.equal(await page.locator('#phone-toggle').isDisabled(), true);
  await page.locator('#enabled').check();
  await page.locator('#mac').check();
  await page.getByRole('radio', { name: 'Banner', exact: true }).check();
  await page.locator('#example').selectOption('approval');
  await page.screenshot({ path: '/tmp/prometeu-notifications-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/prometeu-notifications-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Notification preview: interactions, disabled states, and mobile layout passed.');
} finally {
  await browser.close();
}
