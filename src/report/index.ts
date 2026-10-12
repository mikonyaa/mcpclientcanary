import { writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { type Report, reportSchema, MAX_BYTES, CanaryError } from '../types.js';
import { htmlReport, escapeHtml } from './html.js';
export async function loadReport(path: string): Promise<Report> {
  if ((await stat(path)).size > MAX_BYTES) throw new CanaryError('Report exceeds 16 MiB');
  return reportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
export function junitReport(r: Report): string {
  const esc = escapeHtml;
  const tests = r.cases
    .map((c) => {
      const body =
        c.harnessStatus === 'error'
          ? `<error message="Harness error">${esc(c.errors.join('; '))}</error>`
          : c.harnessStatus !== 'complete'
            ? `<skipped message="Incomplete or unsupported observation">${esc(
                c.stages
                  .filter((s) => s.status === 'not-reached' || s.status === 'not-supported')
                  .map((s) => s.id + ': ' + s.reason)
                  .join('; '),
              )}</skipped>`
            : c.clientContractStatus === 'observed-fail'
              ? `<failure message="Measured client contract violation">${esc(
                  c.stages
                    .filter((s) => s.status === 'observed-fail')
                    .map((s) => s.id + ': ' + s.reason)
                    .join('; '),
                )}</failure>`
              : '';
      return `<testcase classname="${esc(c.client)}" name="${esc(c.scenario)} repeat ${c.repeat}">${body}</testcase>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="MCPClientCanary native contracts" tests="${r.cases.length}" failures="${r.cases.filter((c) => c.harnessStatus === 'complete' && c.clientContractStatus === 'observed-fail').length}" errors="${r.cases.filter((c) => c.harnessStatus === 'error').length}" skipped="${r.cases.filter((c) => ['incomplete', 'cancelled'].includes(c.harnessStatus)).length}">${tests}</testsuite>\n`;
}
export async function writeReports(report: Report, out: string): Promise<void> {
  const r = reportSchema.parse(report);
  await mkdir(out, { recursive: true });
  for (const [name, content] of [
    ['report.json', JSON.stringify(r, null, 2) + '\n'],
    ['report.html', htmlReport(r)],
    ['junit.xml', junitReport(r)],
  ])
    await writeFile(resolve(out, name!), content!, { mode: 0o600, flag: 'wx' });
}
export async function writeHtml(report: Report, path: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, htmlReport(report), { flag: 'wx' });
}
