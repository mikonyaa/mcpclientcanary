import { type Report, reportSchema } from '../types.js';
export const escapeHtml = (s: unknown) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('\u001b', '\\u001b');
function clientApp() {
  const report = JSON.parse(document.querySelector('#report-data')!.textContent!) as Report;
  const esc = (s: unknown) =>
    String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
      .replaceAll('\u001b', '\\u001b');
  const scenario = document.querySelector<HTMLSelectElement>('#scenario')!,
    repeat = document.querySelector<HTMLSelectElement>('#repeat')!,
    filter = document.querySelector<HTMLSelectElement>('#status-filter')!,
    comparison = document.querySelector<HTMLElement>('#comparison')!;
  const scenarios = [...new Set(report.cases.map((c) => c.scenario))],
    repeats = [...new Set(report.cases.map((c) => c.repeat))];
  scenario.innerHTML = scenarios
    .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
    .join('');
  repeat.innerHTML = repeats.map((s) => `<option value="${s}">Repeat ${s}</option>`).join('');
  const labels = [...new Set(report.cases.map((c) => c.client))];
  const status = (s: string) =>
    `<span class="status ${esc(s)}">${esc(s.replaceAll('-', ' '))}</span>`;
  const fragment = (name: string, value: unknown) =>
    `<details class="fragment"><summary>${esc(name)}</summary><pre tabindex="0">${esc(JSON.stringify(value, null, 2))}</pre></details>`;
  function render() {
    comparison.innerHTML = labels
      .map((label) => {
        const c = report.cases.find(
          (c) =>
            c.client === label &&
            c.scenario === scenario.value &&
            c.repeat === Number(repeat.value) &&
            (filter.value === 'all' || c.clientContractStatus === filter.value),
        );
        if (!c)
          return `<article class="client-panel"><h2>${esc(label)}</h2><p class="empty">No case matches these filters.</p></article>`;
        const find = (id: string) => c.stages.find((s) => s.id === id),
          wire = c.evidence.filter(
            (e) => e.producer === 'server' && e.event === 'sent' && e.data.method === 'tools/list',
          );
        const layers = [
          {
            name: 'Server response',
            id: 'notification-wire',
            value: wire.map((e) => ({
              ref: e.ref,
              instance: e.instance,
              pid: e.pid,
              phase: e.phase,
              generation: e.generation,
              ...e.data,
            })),
          },
          {
            name: 'Native loaded result',
            id: 'notification-search',
            value: {
              initial: c.definitions.initial?.loaded,
              afterNotification: c.definitions.notification?.loaded,
              afterResume: c.definitions.resume?.loaded,
              nativeResultEvents: c.evidence.filter((e) => e.event === 'loaded-result'),
            },
          },
          { name: 'Current model input', id: 'notification-current', value: c.definitions },
          { name: 'Resume continuity', id: 'resume-continuity', value: c.continuity },
        ];
        return `<article class="client-panel"><div class="client-heading"><div><span class="eyebrow">CLAUDE CODE · ${esc(report.environment.os)} / ${esc(report.environment.arch)}</span><h2>${esc(c.nativeVersion)}</h2></div>${status(c.clientContractStatus)}</div><p class="case-note">${esc(label)} · harness ${esc(c.harnessStatus)} · exit ${c.exitCode}</p><ol class="timeline"><li><b>01</b><span>Initial load</span>${status(find('initial-current')?.status ?? 'not-reached')}</li><li><b>02</b><span>Live notification</span>${status(find('notification-current')?.status ?? 'not-reached')}</li><li><b>03</b><span>Native resume</span>${status(find('resume-current')?.status ?? 'not-reached')}</li></ol><div class="layers">${layers
          .map((l) => {
            const s = find(l.id);
            const marker =
              String(c.definitions.notification?.current?.description ?? '').match(
                /CANARY_(?:SCHEMA_[AB]|ADDED_B)/,
              )?.[0] ?? 'unresolved';
            const loadedNote =
              l.id === 'notification-search'
                ? `<p><b>Native reference → ${esc(marker)}</b><br>The result carries a reference, not an inline schema. Freshness is evaluated against current model input below.</p>`
                : '';
            return `<section class="layer"><div class="layer-title"><h3>${l.name}</h3>${status(s?.status ?? 'not-reached')}</div><p>${esc(s?.reason ?? 'Stage not reached')}</p>${loadedNote}${fragment('Inspect evidence', l.value)}</section>`;
          })
          .join(
            '',
          )}</div><details class="stages"><summary>All ${c.stages.length} stages and evidence references</summary><div class="stage-list">${c.stages.map((s) => `<div class="stage"><span class="mono">${esc(s.id)}</span>${status(s.status)}<p>${esc(s.reason)}</p><small>${esc(s.evidenceRefs.join(' · '))}</small></div>`).join('')}</div></details>${c.errors.length ? `<div class="error-box"><b>Harness error</b><p>${esc(c.errors.join('; '))}</p></div>` : ''}${fragment('Bounded recorder streams', c.evidence)}<p class="case-id mono">Case ${esc(c.id)} · ${esc(c.window.predeclaredObservationMs)} ms window</p></article>`;
      })
      .join('');
    if (!labels.length)
      comparison.innerHTML =
        '<div class="empty"><h2>No native cases recorded</h2><p>This report has incomplete coverage. Run the native CLI to collect evidence.</p></div>';
  }
  [scenario, repeat, filter].forEach((el) => el.addEventListener('change', render));
  render();
  document.querySelector('#copy-command')!.addEventListener('click', () => {
    const text = report.reproduceCommands[0] ?? '';
    const fallback = () => {
      const box = document.querySelector<HTMLTextAreaElement>('#copy-fallback')!;
      box.hidden = false;
      box.value = text;
      box.focus();
      box.select();
      document.querySelector('#copy-message')!.textContent =
        'Select the command and copy with your keyboard.';
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          document.querySelector('#copy-message')!.textContent = 'Command copied.';
        })
        .catch(fallback);
    } else fallback();
  });
}
const css = `
:root{--bg:#f4f4ef;--paper:#fff;--ink:#1c2d35;--muted:#4f616a;--line:#d7ddd9;--accent:#e8c54e;--danger:#9c2f27;--danger-bg:#fff0ed;--pass:#276246;--pass-bg:#e9f5ec;--unknown:#805e11;--unknown-bg:#fff6dc;--mono:Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 'Avenir Next','Trebuchet MS',sans-serif}a{color:var(--ink)}.masthead{background:var(--ink);color:var(--paper);border-bottom:5px solid var(--accent);padding:20px max(24px,calc((100vw - 1320px)/2));display:flex;justify-content:space-between;align-items:center;gap:16px}.brand{font-weight:750;letter-spacing:-.03em;font-size:20px}.brand i{font:normal 16px var(--mono);background:var(--accent);color:var(--ink);padding:3px 8px;margin-right:10px}.masthead small{color:var(--line);font-family:var(--mono)}main{max-width:1368px;margin:auto;padding:42px 24px 60px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:10px;font-weight:700;color:var(--muted)}h1{font-size:clamp(28px,4vw,44px);line-height:1.1;letter-spacing:-.045em;margin:10px 0 16px}h2{font-size:28px;line-height:1.2;margin:7px 0}h3{font-size:16px;margin:0}.lede{max-width:740px;color:var(--muted);margin:0 0 20px}.coverage{border:1px solid var(--line);border-left:5px solid var(--ink);background:var(--paper);padding:16px 20px;display:flex;justify-content:space-between;gap:24px;align-items:center}.coverage p{margin:2px 0}.coverage strong{font-size:19px}.coverage .mono{font-size:12px;overflow-wrap:anywhere}.summary-data{display:flex;gap:25px;flex-wrap:wrap}.summary-data b{display:block;font-size:25px;line-height:1.2}.summary-data span{font-size:11px;color:var(--muted);white-space:nowrap}.toolbar{display:flex;gap:20px;align-items:end;margin:30px 0 22px;border-bottom:1px solid var(--line);padding-bottom:22px}.toolbar label{display:flex;flex-direction:column;gap:5px;font-weight:600;font-size:12px;flex:1;min-width:0}select,button,textarea{font:inherit;color:var(--ink);border:1px solid var(--line);border-radius:2px;background:var(--paper)}select{width:100%;padding:10px 30px 10px 11px;min-height:44px}button{padding:10px 16px;min-height:44px;cursor:pointer;font-weight:700}button:hover{border-color:var(--ink)}:focus-visible{outline:3px solid var(--unknown);outline-offset:3px}.comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;align-items:start}.client-panel{background:var(--paper);border:1px solid var(--line);min-width:0;padding:24px}.client-heading{display:flex;justify-content:space-between;gap:16px;align-items:center}.client-heading h2{font-family:var(--mono);font-size:30px;letter-spacing:-.05em}.case-note{color:var(--muted);font-size:12px;overflow-wrap:anywhere;margin:10px 0 22px}.status{font:600 10px/1.5 var(--mono);text-transform:uppercase;letter-spacing:.02em;border:1px solid currentColor;border-radius:2px;padding:3px 6px;display:inline-block;white-space:normal;text-align:center}.observed-fail{color:var(--danger);background:var(--danger-bg)}.observed-pass{color:var(--pass);background:var(--pass-bg)}.unknown,.not-supported,.not-reached{color:var(--unknown);background:var(--unknown-bg)}.timeline{margin:0 0 25px;padding:0;list-style:none;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.timeline li{border-top:3px solid var(--ink);padding-top:10px;display:flex;flex-direction:column;align-items:start;gap:7px}.timeline b{font:12px var(--mono);color:var(--muted)}.timeline li>span:not(.status){font-size:12px;line-height:1.4}.layers{border-top:1px solid var(--line)}.layer{padding:17px 0;border-bottom:1px solid var(--line)}.layer-title{display:flex;justify-content:space-between;align-items:start;gap:12px}.layer p{font-size:12px;color:var(--muted);margin:8px 0 12px;overflow-wrap:anywhere}.fragment summary,.stages summary{cursor:pointer;font-weight:600;font-size:12px;padding:8px 0}.fragment summary:hover,.stages summary:hover{text-decoration:underline}pre{font:11px/1.6 var(--mono);background:var(--bg);border:1px solid var(--line);padding:13px;max-height:280px;overflow:auto;white-space:pre;margin:8px 0;max-width:100%;tab-size:2}.stages{margin:17px 0}.stage-list{margin-top:12px}.stage{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;border-top:1px solid var(--line);padding:12px 0;font-size:12px}.stage p,.stage small{grid-column:1/-1;margin:0;overflow-wrap:anywhere}.stage small{font:10px var(--mono);color:var(--muted)}.mono{font-family:var(--mono)}.case-id{font-size:10px;color:var(--muted);overflow-wrap:anywhere}.error-box{border:1px solid var(--danger);background:var(--danger-bg);color:var(--danger);padding:12px;overflow-wrap:anywhere}.empty{padding:22px;color:var(--muted)}.reproduce{margin-top:32px;border-top:1px solid var(--line);padding-top:24px}.reproduce h2{font-size:19px}.reproduce p,footer{font-size:12px;color:var(--muted)}textarea{width:100%;padding:12px;min-height:85px;font-family:var(--mono);margin-top:10px}.limit{background:var(--unknown-bg);border-left:3px solid var(--unknown);padding:12px 16px;margin-top:22px;font-size:12px}footer{margin-top:35px;border-top:1px solid var(--line);padding-top:18px;overflow-wrap:anywhere}@media(max-width:760px){main{padding:28px 16px}.masthead{padding:16px;flex-direction:column;align-items:start}.comparison{grid-template-columns:1fr}.coverage{align-items:start;flex-direction:column;gap:15px}.summary-data{gap:23px}.toolbar{flex-wrap:wrap;gap:12px}.toolbar label{flex-basis:40%}.toolbar button{width:100%}.client-panel{padding:18px}.client-heading{gap:10px}.client-heading h2{font-size:26px}.layer-title h3{font-size:14px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
`;
export function htmlReport(input: Report): string {
  const r = reportSchema.parse(input);
  const incomplete = r.cases.some((c) => c.harnessStatus !== 'complete') || !r.cases.length,
    failed = r.cases.filter((c) => c.clientContractStatus === 'observed-fail').length,
    measured = r.cases.filter((c) => c.harnessStatus === 'complete').length;
  const safeData = JSON.stringify(r)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>MCPClientCanary · native state evidence</title><style>${css}</style></head><body><header class="masthead"><div class="brand"><i>m/c</i>MCPClientCanary</div><small>${r.recorded ? 'RECORDED MEASUREMENT' : 'LOCAL NATIVE RUN'} · ${escapeHtml(r.timestamp.slice(0, 10))} UTC · v${escapeHtml(r.toolVersion)}</small></header><main><span class="eyebrow">Native client regression harness</span><h1>Follow the definition.</h1><p class="lede">Compare what the MCP server sent, what native ToolSearch loaded, and what Claude Code sent to the model endpoint. Every conclusion has its own evidence.</p><section class="coverage" aria-label="Run coverage"><div><strong>${incomplete ? 'Incomplete native coverage' : failed ? 'Measured client contract violations' : 'Selected contracts observed to pass'}</strong><p>Harness ${incomplete ? 'incomplete' : 'complete'} · MCP ${escapeHtml(r.negotiatedProtocol)} · stdio · synthetic loopback</p><p class="mono">${escapeHtml(r.environment.os)} / ${escapeHtml(r.environment.arch)} · ${escapeHtml(r.environment.osVersion)} · exit ${r.exitCode}</p></div><div class="summary-data"><div><b>${new Set(r.cases.map((c) => c.nativeVersion)).size}</b><span>native versions</span></div><div><b>${measured}/${r.cases.length}</b><span>cases measured</span></div><div><b>${failed}</b><span>client failures</span></div></div></section>${r.recorded ? '<p class="limit"><b>Recorded report.</b> This page displays an earlier synthetic measurement. It does not test your current native runtime. Use the CLI to run a new measurement.</p>' : ''}<div class="toolbar"><label>Scenario<select id="scenario" aria-label="Scenario"></select></label><label>Independent run<select id="repeat" aria-label="Independent run"></select></label><label>Client outcome<select id="status-filter" aria-label="Client outcome"><option value="all">All outcomes</option><option value="observed-fail">Observed failure</option><option value="observed-pass">Observed pass</option><option value="unknown">Unknown / unmeasured</option></select></label><button id="copy-command">Copy run command</button></div><div id="comparison" class="comparison" aria-live="polite"></div><section class="reproduce"><h2>Run it again</h2><pre tabindex="0">${escapeHtml(r.reproduceCommands.join('\n'))}</pre><p id="copy-message" role="status">Commands use your own local executable manifest.</p><textarea id="copy-fallback" aria-label="Command to copy" hidden readonly></textarea><p>Same-name updates and newly added tools are separate cases. A stale native definition is a client lifecycle finding; this report does not certify MCP conformity.</p></section><div class="limit"><b>Observation boundary.</b> No model inference ran. Tool references resolve against unique definitions in the captured request. Historical A is preserved separately and does not by itself imply stale state. Reconnect is unsupported by this adapter.</div><footer>Source ${escapeHtml(r.sourceCommit)} · run ${escapeHtml(r.runId)}<br>Public evidence contains synthetic definitions, tool references and minimal process provenance. Native system prompts, credentials, headers and session files are excluded.</footer></main><script id="report-data" type="application/json">${safeData}</script><script>(${clientApp.toString()})();</script></body></html>`;
}
