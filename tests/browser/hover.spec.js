import { expect, test } from '@playwright/test';

test('unpressed mouse tracks across titles, legends and panel gaps in a stage view', async ({ page }) => {
  await page.goto('/');
  await page.locator('#ribbon').getByRole('button', { name: /^第一阶段去噪/ }).click();
  const panel = page.locator('.lc-panel').filter({ has: page.getByRole('heading', { name: '内存与显存' }) });
  await panel.scrollIntoViewIfNeeded();
  const title = await panel.locator('.lc-title').boundingBox();
  const legend = await panel.locator('.lc-legend').boundingBox();
  const bounds = await panel.boundingBox();
  const left = title.x + title.width / 2;
  const right = legend.x + legend.width / 2;
  // Cross two formerly inactive areas before entering the plotted curves.
  const path = [
    [left, title.y + title.height / 2],
    [right, legend.y + legend.height / 2],
    [left, bounds.y + 2],
    [right, bounds.y + 2],
    [left, bounds.y + bounds.height / 2],
  ];
  const cursors = page.locator('.lc-cursor');
  await expect(cursors).toHaveCount(5);
  for (const [x, y] of path) {
    await page.mouse.move(x, y);
    await expect.poll(() => cursors.evaluateAll((lines, pointerX) =>
      Math.max(...lines.map(line => Math.abs(line.getBoundingClientRect().left - pointerX))), x)
    ).toBeLessThan(1);
    const time = await page.locator('#cursor-time').textContent();
    await expect(page.locator('.lc-cursor-time')).toHaveText(Array(5).fill(time + ' s'));
  }
});
