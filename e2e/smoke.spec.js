import { test, expect } from '@playwright/test';

test('health and auth screen', async ({ page, request }) => {
  const health = await request.get('/api/health');
  expect(health.ok()).toBeTruthy();
  const body = await health.json();
  expect(body.name).toBe('Cbopka');
  await page.goto('/');
  await expect(page.getByText('Cbopka').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Быстрый вход гостем' })).toBeVisible();
});
