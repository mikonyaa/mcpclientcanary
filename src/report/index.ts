import { readFile, stat } from 'node:fs/promises';
import { type Report, MAX_BYTES, CanaryError } from '../types.js';
import { validateReport } from './validate.js';
import { htmlReport } from './html.js';
import { escapeXml } from './xml.js';
import { publishBundle, publishHtml, type PublicationOptions } from './transaction.js';
export async function loadReport(path: string): Promise<Report> {
  if ((await stat(path)).size > MAX_BYTES) throw new CanaryError('Report exceeds 16 MiB');
  return validateReport(JSON.parse(await readFile(path, 'utf8')));
}
export function junitReport(r: Report): string {
  r = validateReport(r);
  const esc = escapeXml;
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
export async function writeReports(
  report: Report,
  out: string,
  options: PublicationOptions = {},
): Promise<void> {
  const r = validateReport(report);
  await publishBundle(
    out,
    [
      ['report.json', JSON.stringify(r, null, 2) + '\n'],
      ['report.html', htmlReport(r)],
      ['junit.xml', junitReport(r)],
    ],
    options,
  );
}
export async function writeHtml(
  report: Report,
  path: string,
  options: PublicationOptions = {},
): Promise<void> {
  await publishHtml(path, htmlReport(report), options);
}
