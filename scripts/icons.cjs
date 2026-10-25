/**
 * Renders the app icons from their SVG sources with the pre-installed Chromium.
 * Run: node scripts/icons.cjs   (writes packages/web/public/icons/*.png)
 */
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const src = join(__dirname, '../packages/web/icons');
const out = join(__dirname, '../packages/web/public/icons');
const icons = [
  ['square.svg', 'icon-180.png', 180],
  ['square.svg', 'icon-192.png', 192],
  ['square.svg', 'icon-512.png', 512],
  ['maskable.svg', 'icon-maskable-512.png', 512],
];

(async () => {
  const browser = await chromium.launch();
  for (const [from, to, size] of icons) {
    const svg = readFileSync(join(src, from), 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `);
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:#020406}</style>${svg}`);
    await page.screenshot({ path: join(out, to) });
    await page.close();
  }
  await browser.close();
})();
