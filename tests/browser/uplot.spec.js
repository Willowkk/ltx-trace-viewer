import { expect, test } from '@playwright/test';

test('resource charts preserve gaps and isolated readings across stage windows', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const trace = {
    duration: 10,
    samples: [
      { time: 0, cpu: 20 }, { time: 1, cpu: 20 }, { time: 2, cpu: null },
      { time: 3, cpu: 20 }, { time: 4, cpu: 20 }, { time: 5, cpu: null },
      { time: 6, cpu: 70 }, { time: 7, cpu: null }, { time: 10, gpu: 0 },
    ],
    stages: [
      { id: 'single', name: '单点区间', start: 5.75, end: 6.25 },
      { id: 'empty', name: '空区间', start: 8, end: 10 },
    ],
  };
  await page.locator('#file').setInputFiles({
    name: 'gaps.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(trace)),
  });
  await expect(page.locator('#sample-count')).toHaveText('9');
  await expect(page.locator('.uplot .u-wrap canvas')).toHaveCount(4);

  // Inspect only the CPU stroke within the plotting rectangle. Grid lines and
  // the translucent area under the curve should not count as a measured line.
  async function hasCpuStroke(fraction) {
    return page.locator('.uplot').first().evaluate((chart, fraction) => {
      const canvas = chart.querySelector('canvas');
      const box = canvas.getBoundingClientRect();
      const plot = chart.querySelector('.u-over').getBoundingClientRect();
      const ratio = canvas.width / box.width;
      const x = Math.floor((plot.left - box.left + plot.width * fraction) * ratio);
      const y = Math.round((plot.top - box.top) * ratio);
      const pixels = canvas.getContext('2d').getImageData(x - 2, y, 5, Math.round(plot.height * ratio)).data;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 2] > 180 && pixels[i] < 60 && pixels[i + 3] > 150) return true;
      }
      return false;
    }, fraction);
  }
  await expect.poll(() => hasCpuStroke(.05)).toBe(true);
  expect(await hasCpuStroke(.20)).toBe(false);
  expect(await hasCpuStroke(.60)).toBe(true);

  await page.locator('#ribbon').getByRole('button', { name: /^单点区间/ }).click();
  await expect(page.locator('#sample-time')).toHaveText('最近采样 6.000 s');
  await expect.poll(() => hasCpuStroke(.5)).toBe(true);

  await page.locator('#ribbon').getByRole('button', { name: /^空区间/ }).click();
  await expect(page.locator('#sample-time')).toHaveText('窗口内无采样');
  await expect(page.locator('.lc-empty-metric')).toHaveCount(4);
  await page.getByRole('slider').first().press('End');
  await expect(page.locator('#cursor-time')).toHaveText('10.00');
  await expect(page.locator('#cursor-stage')).toHaveText('空区间 · 阶段终点');
  await expect(page.locator('#sample-time')).toHaveText('窗口内无采样');
});
