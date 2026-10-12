#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'smoke-artifacts');
fs.mkdirSync(outDir, { recursive: true });
const evidence = { at: new Date().toISOString(), steps: [] };
const step = (name, ok, detail) => {
  evidence.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const base = process.env.SIDEX_PREVIEW_URL || 'http://127.0.0.1:4173';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(45000);

try {
  const res = await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  step('web.preview.load', !!res && res.ok(), `status=${res?.status()}`);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(outDir, 'web-workbench.png'), fullPage: true });
  const title = await page.title();
  step('web.preview.title', /sidex/i.test(title) || title.length > 0, title);

  // Command palette / keyboard — VS Code style
  await page.keyboard.press('Control+Shift+P');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, 'web-command-palette.png') });
  const paletteVisible = await page.locator('.quick-input-widget, .monaco-quick-input-widget, [aria-label*="Input"]').count();
  step('web.commandPalette', paletteVisible > 0, `matches=${paletteVisible}`);

  // Type Extensions to open marketplace view if palette works
  if (paletteVisible > 0) {
    await page.keyboard.type('Extensions: Install Extensions', { delay: 20 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(outDir, 'web-extensions-view.png') });
    const extUi = await page.locator('.extensions-viewlet, .monaco-list, [id*="workbench.view.extensions"]').count();
    step('web.extensionsView', extUi > 0, `matches=${extUi}`);
  } else {
    step('web.extensionsView', false, 'palette not available');
  }

  // Marketplace API still reachable from page context (CORS may block — record either way)
  const apiFromPage = await page.evaluate(async () => {
    try {
      const r = await fetch('https://marketplace.siden.ai/api/-/search?query=markdown&size=1');
      const j = await r.json();
      return { ok: r.ok, count: (j.extensions || []).length, err: null };
    } catch (e) {
      return { ok: false, count: 0, err: String(e) };
    }
  });
  step('web.page.marketplaceFetch', apiFromPage.ok && apiFromPage.count > 0, JSON.stringify(apiFromPage));
} catch (e) {
  step('web.preview.error', false, String(e));
  await page.screenshot({ path: path.join(outDir, 'web-error.png') }).catch(() => {});
} finally {
  await browser.close();
  fs.writeFileSync(path.join(outDir, 'interactive-web-evidence.json'), JSON.stringify(evidence, null, 2));
  const failed = evidence.steps.filter(s => !s.ok);
  console.log(`\n${evidence.steps.length - failed.length}/${evidence.steps.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
