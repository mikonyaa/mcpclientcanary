import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { htmlReport } from '../dist/report/html.js';
import { aggregateExit } from '../dist/verdict/contracts.js';
import { unsupportedReport } from '../tests/helpers/report.mjs';
const out = resolve('test-results/ui');
await mkdir(out, { recursive: true });
const original = JSON.parse(await readFile('examples/recorded-report.json', 'utf8'));
const browser = await chromium.launch({ headless: true });
let checks = 0;
const results = [];
async function variant(kind) {
  const r = structuredClone(original);
  r.recorded = true;
  if (kind === 'empty') {
    r.cases = [];
    r.exitCode = 3;
  }
  if (kind === 'all-failed')
    r.cases = r.cases.filter((c) => c.clientContractStatus === 'observed-fail');
  if (kind === 'all-unknown') {
    const unsupported = await unsupportedReport(resolve(out, 'unsupported-runs'));
    Object.assign(r, unsupported);
  }
  if (kind === 'error')
    for (const c of r.cases) {
      c.harnessStatus = 'error';
      c.clientContractStatus = 'unknown';
      c.exitCode = 2;
      c.errors = ['Synthetic protocol drift: invalid request'];
    }
  if (kind === 'hostile') {
    for (const c of r.cases) {
      c.client =
        'Long label ' +
        c.nativeVersion +
        ' ' +
        '</script><img src=x onerror="globalThis.pwned=1">\u001b[31m'.repeat(8);
      for (const s of c.stages)
        s.reason =
          'Very long synthetic description </pre><script>globalThis.pwned=1</script> '.repeat(30);
    }
    r.sourceCommit = '</script><script>globalThis.pwned=1</script>';
    r.reproduceCommands = ['synthetic ' + 'x'.repeat(180)];
    r.clients = r.clients.map((client) => ({
      ...client,
      label: r.cases.find((c) => c.nativeVersion === client.nativeVersion).client,
    }));
  }
  r.exitCode = aggregateExit(r.cases.map((c) => c.exitCode));
  return r;
}
try {
  for (const kind of ['actual', 'all-failed', 'all-unknown', 'empty', 'error', 'hostile']) {
    const report = await variant(kind);
    for (const width of [1440, 1024, 390]) {
      const file = resolve(out, `${kind}-${width}.html`);
      await writeFile(file, htmlReport(report));
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      const errors = [];
      const networks = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('request', (r) => {
        if (!/^(file:|blob:)/.test(r.url())) networks.push(r.url());
      });
      await page.goto(pathToFileURL(file).href);
      assert.equal(errors.length, 0);
      checks++;
      assert(await page.locator('meta[http-equiv="Content-Security-Policy"]').count());
      checks++;
      const headline = await page.locator('.coverage strong').innerText();
      assert(
        !headline.includes('Selected contracts observed to pass') ||
          !report.cases.some((c) => c.stages.some((s) => s.status === 'observed-fail')),
      );
      checks++;
      assert.equal(networks.length, 0);
      checks++;
      assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
      checks++;
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      checks++;
      if (kind !== 'empty') {
        const options = await page.locator('#scenario option').count();
        assert.equal(options, new Set(report.cases.map((c) => c.scenario)).size);
        checks++;
        if (kind === 'actual') {
          await page.locator('#scenario').selectOption('added-tool');
          assert.equal(
            await page.getByText('Native reference → CANARY_ADDED_B', { exact: true }).count(),
            2,
          );
          checks++;
        }
        await page
          .locator('#scenario')
          .selectOption(kind === 'all-unknown' ? 'same-name' : 'description-only');
        await page
          .locator('#repeat')
          .selectOption(String(Math.max(...report.cases.map((c) => c.repeat))));
        assert((await page.locator('.client-panel').count()) >= 1);
        checks++;
        await page.locator('.fragment summary').first().click();
        assert(await page.locator('.fragment[open] pre').first().isVisible());
        checks++;
        await page.locator('.stages summary').first().click();
        assert((await page.locator('.stage').count()) > 0);
        checks++;
        await page.locator('#status-filter').selectOption('observed-pass');
        await page.locator('#status-filter').selectOption('all');
        checks++;
      } else {
        assert((await page.locator('#comparison').innerText()).includes('No native cases'));
        checks++;
      }
      await page.locator('#scenario').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'repeat');
      checks++;
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }),
      );
      await page.locator('#copy-command').click();
      assert(await page.locator('#copy-fallback').isVisible());
      checks++;
      assert.equal(await page.evaluate(() => document.activeElement.id), 'copy-fallback');
      checks++;
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export report JSON' }).click();
      const download = await downloadPromise,
        exported = resolve(out, `${kind}-${width}-export.json`);
      await download.saveAs(exported);
      assert.deepEqual(JSON.parse(await readFile(exported, 'utf8')), report);
      checks++;
      await page.locator('#scenario').selectOption(kind === 'empty' ? [] : 'same-name');
      await page.evaluate(() => window.scrollTo(0, 0));
      if (kind === 'actual')
        await page.screenshot({ path: resolve(out, `report-${width}.png`), fullPage: true });
      if (kind === 'hostile' && width === 390)
        await page.screenshot({ path: resolve(out, 'hostile-390.png'), fullPage: true });
      results.push({ kind, width, passed: true });
      await context.close();
    }
  }
  for (const width of [1440, 1024, 390]) {
    const malformed = structuredClone(original);
    malformed.exitCode = 0;
    const input = resolve(out, `malformed-${width}.json`),
      output = resolve(out, `malformed-${width}.html`);
    await writeFile(input, JSON.stringify(malformed));
    assert.throws(() => htmlReport(malformed));
    checks++;
    const result = spawnSync(
      process.execPath,
      ['dist/cli/main.js', 'report', input, '--out', output, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2, result.stderr);
    checks++;
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(output));
    checks++;
    results.push({ kind: 'malformed-rejected', width, passed: true });
  }
  await writeFile(
    resolve(out, 'acceptance.json'),
    JSON.stringify(
      { browser: 'Playwright Chromium', fileProtocol: true, checks, cases: results },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      uiAcceptance: 'passed',
      viewports: [1440, 1024, 390],
      checks,
      cases: results.length,
      out,
    }),
  );
} finally {
  await browser.close();
}
