#!/usr/bin/env node
// Writes report.html from results.json: both verdicts, the per-workload numbers,
// which strategies fired, and both answers side by side.
//
//   node prove.mjs && node report.mjs
//
// report.html is gitignored — it contains your prompts and the model's answers.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fmtUSD } from './lib/rates.mjs';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const n = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));

const STYLE = `
:root {
  color-scheme: light;
  --paper: #fbfcfd;
  --panel: #ffffff;
  --ink: #111820;
  --ink-soft: #55636f;
  --rule: #dfe5ea;
  --rule-strong: #c3ced7;
  --accent: #0e6a6a;
  --ok: #1d6b47;
  --warn: #8a5a00;
  --bad: #a32b2b;
  --bad-wash: #fdf3f3;
  --warn-wash: #fdf8ee;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --paper: #0e1317;
    --panel: #151c22;
    --ink: #e6ecf1;
    --ink-soft: #97a5b1;
    --rule: #232d35;
    --rule-strong: #34424d;
    --accent: #4dbcb2;
    --ok: #59b98b;
    --warn: #d6a44b;
    --bad: #e58080;
    --bad-wash: #241a1a;
    --warn-wash: #241f16;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --paper: #0e1317;
  --panel: #151c22;
  --ink: #e6ecf1;
  --ink-soft: #97a5b1;
  --rule: #232d35;
  --rule-strong: #34424d;
  --accent: #4dbcb2;
  --ok: #59b98b;
  --warn: #d6a44b;
  --bad: #e58080;
  --bad-wash: #241a1a;
  --warn-wash: #241f16;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 68rem; margin: 0 auto; padding: 3rem 1.5rem 5rem; display: flex; flex-direction: column; gap: 2.5rem; }
h1, h2, h3 { text-wrap: balance; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
h1 { font-size: 1.9rem; }
h2 { font-size: 1.05rem; }
p { margin: 0; max-width: 62ch; }
code, .mono, td.num, th.num { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }

.eyebrow {
  font-family: "IBM Plex Mono", ui-monospace, monospace;
  font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-soft);
}

/* Masthead — the run slip: what was measured, where, how many times. */
.masthead { display: flex; flex-direction: column; gap: 1rem; border-bottom: 2px solid var(--rule-strong); padding-bottom: 1.5rem; }
.slip { display: flex; flex-wrap: wrap; gap: 0 2rem; font-size: 0.82rem; }
.slip div { display: flex; gap: 0.5rem; padding: 0.15rem 0; }
.slip dt { color: var(--ink-soft); }
.slip dd { margin: 0; font-family: "IBM Plex Mono", ui-monospace, monospace; }

.caveat { border-left: 3px solid var(--accent); padding: 0.1rem 0 0.1rem 1.1rem; display: flex; flex-direction: column; gap: 0.5rem; }
.caveat strong { font-weight: 600; }

.verdicts { display: grid; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); gap: 1.25rem; }
.verdict { background: var(--panel); border: 1px solid var(--rule); padding: 1.4rem; display: flex; flex-direction: column; gap: 0.7rem; }
.verdict .headline { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 1.7rem; font-variant-numeric: tabular-nums; line-height: 1.2; }
.verdict .basis { font-size: 0.82rem; color: var(--ink-soft); }
ul.basis { margin: 0; padding-left: 1.15rem; display: flex; flex-direction: column; gap: 0.25rem; }
.verdict.fail { background: var(--bad-wash); border-color: var(--bad); }
.verdict.soft { background: var(--warn-wash); border-color: var(--warn); }
.pass { color: var(--ok); }
.fail-text { color: var(--bad); }
.warn-text { color: var(--warn); }

section { display: flex; flex-direction: column; gap: 0.9rem; }
.section-note { color: var(--ink-soft); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.87rem; }
th, td { text-align: left; padding: 0.55rem 0.7rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-soft); font-weight: 500; white-space: nowrap; }
td.num, th.num { text-align: right; white-space: nowrap; }
tbody tr.regressed td { background: var(--bad-wash); }
tbody tr.regressed td:first-child { box-shadow: inset 3px 0 0 var(--bad); }
.flag { display: block; font-size: 0.78rem; color: var(--bad); }
.flag.mild { color: var(--warn); }
.tag { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 0.72rem; color: var(--ink-soft); }

details { border: 1px solid var(--rule); background: var(--panel); }
details + details { border-top: none; }
summary { cursor: pointer; padding: 0.7rem 0.9rem; font-size: 0.87rem; display: flex; gap: 0.75rem; align-items: baseline; }
summary::-webkit-details-marker { color: var(--ink-soft); }
summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.answers { display: grid; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); gap: 1px; background: var(--rule); border-top: 1px solid var(--rule); }
.answer { background: var(--panel); padding: 0.9rem; display: flex; flex-direction: column; gap: 0.5rem; }
.answer pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 0.78rem; line-height: 1.5; max-height: 26rem; overflow-y: auto; }

footer { border-top: 1px solid var(--rule); padding-top: 1.5rem; display: flex; flex-direction: column; gap: 0.6rem; font-size: 0.85rem; color: var(--ink-soft); }
footer a { color: var(--accent); }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

function costPanel(s) {
  const { cost } = s;
  if (!s.rows.some((r) => r.bypassed && r.optimized)) {
    return `<section class="verdict soft"><span class="eyebrow">1 — Cost</span>
      <p class="headline">not measured</p>
      <p class="basis">No workload completed both arms.</p></section>`;
  }
  return `<section class="verdict">
    <span class="eyebrow">1 — Cost</span>
    <p class="headline">${n(cost.before)} → ${n(cost.after)}<br><span class="pass">${cost.savedPct}% lower</span></p>
    <p class="basis">Input tokens, counted by the provider's own <code>usage</code> field on both runs — not estimated here.${
      cost.priced
        ? ` At published list price for <code>${esc(s.model)}</code>: <strong>${fmtUSD(cost.beforeUSD)} → ${fmtUSD(cost.afterUSD)}</strong>.`
        : ` No published rate for <code>${esc(s.model)}</code> in rates.json, so tokens only.`
    }</p>
    ${
      cost.cacheSeen
        ? `<p class="basis">The provider reported cached input on this run. Cached tokens are counted at full weight above, so a cache hit cannot be booked as a saving.</p>`
        : ''
    }
  </section>`;
}

function qualityPanel(s) {
  const q = s.quality;
  if (q.regressions.length) {
    return `<section class="verdict fail">
      <span class="eyebrow">2 — Quality</span>
      <p class="headline fail-text">${q.regressions.length} of ${q.checked}<br>lost a fact</p>
      <p class="basis">These workloads carried the required fact <strong>without</strong> Anyray and stopped carrying it <strong>with</strong> Anyray:</p>
      <ul class="basis">${q.regressions
        .map((r) => `<li><code>${esc(r.id)}</code> — ${esc(r.facts.lost.join(', '))}</li>`)
        .join('')}</ul>
    </section>`;
  }
  if (q.checked === 0) {
    return `<section class="verdict soft"><span class="eyebrow">2 — Quality</span>
      <p class="headline">inconclusive</p>
      <p class="basis">No workload kept all of its required facts without Anyray either, so this run cannot attribute anything to us. Check the facts in your workload files.</p></section>`;
  }
  return `<section class="verdict">
    <span class="eyebrow">2 — Quality</span>
    <p class="headline pass">${q.clean} of ${q.checked}<br>facts intact</p>
    <p class="basis">Every fact these workloads declared as required survived, in all ${s.repeats} run${s.repeats === 1 ? '' : 's'} with Anyray on.${
      q.inconclusive.length
        ? ` ${q.inconclusive.length} further workload(s) are not counted: the answer missed a required fact without Anyray too.`
        : ''
    }</p>
  </section>`;
}

function tableRows(rows) {
  return rows
    .map((r) => {
      if (!r.bypassed || !r.optimized) {
        return `<tr><td><code>${esc(r.id)}</code></td><td colspan="5" class="flag">${esc(r.errors[0] ?? 'no successful runs')}</td></tr>`;
      }
      const flags = [];
      if (r.facts.regression) {
        flags.push(`<span class="flag">only missing with Anyray on: ${esc(r.facts.lost.join(', '))}</span>`);
      }
      if (r.facts.inconclusive && !r.facts.regression) {
        flags.push(`<span class="flag mild">missing from both answers, so not counted: ${esc(r.facts.missingBoth.join(', '))}</span>`);
      }
      for (const arm of ['bypassed', 'optimized']) {
        if (r.inconsistent[arm]) {
          flags.push(
            `<span class="flag">${arm} repeats disagree on input tokens (${esc(r.inconsistent[arm].join(', '))}) — identical bytes should give an identical count</span>`
          );
        }
      }
      const facts = r.facts.regression
        ? `<span class="fail-text">${r.facts.optimizedKept}/${r.facts.total}</span> vs ${r.facts.bypassedKept}/${r.facts.total}`
        : r.facts.inconclusive
          ? `<span class="warn-text">${r.facts.optimizedKept}/${r.facts.total}</span>`
          : `<span class="pass">${r.facts.optimizedKept}/${r.facts.total}</span>`;
      return `<tr class="${r.facts.regression ? 'regressed' : ''}">
        <td><code>${esc(r.id)}</code>${flags.join('')}</td>
        <td class="num">${n(r.bypassed.billedInput)}</td>
        <td class="num">${n(r.optimized.billedInput)}</td>
        <td class="num">${r.savedPct}%</td>
        <td class="num">${facts}</td>
        <td class="tag">${esc(r.strategies.join(', ') || '—')}</td>
      </tr>`;
    })
    .join('\n');
}

function answerBlocks(rows) {
  return rows
    .filter((r) => r.answers.bypassed || r.answers.optimized)
    .map(
      (r) => `<details>
      <summary><code>${esc(r.id)}</code> <span class="tag">${esc(r.title ?? '')}</span></summary>
      <div class="answers">
        <div class="answer"><span class="eyebrow">Baseline — your prompt as written</span><pre>${esc(r.answers.bypassed ?? '(no answer)')}</pre></div>
        <div class="answer"><span class="eyebrow">Optimized — trimmed locally</span><pre>${esc(r.answers.optimized ?? '(no answer)')}</pre></div>
      </div>
    </details>`
    )
    .join('\n');
}

export function renderReport(data) {
  const s = data.summary;
  let host = data.providerUrl;
  try {
    host = new URL(data.providerUrl).host;
  } catch {
    /* a non-URL provider string still prints fine as-is */
  }
  const prov = data.provenance ?? {};
  return `<title>Proof run · ${esc(host)}</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${STYLE}</style>
<div class="wrap">
  <header class="masthead">
    <span class="eyebrow">Anyray proof run</span>
    <h1>Two verdicts on your own prompts</h1>
    <dl class="slip">
      <div><dt>provider</dt><dd>${esc(host)}</dd></div>
      <div><dt>optimizer</dt><dd>${esc(data.optimizerUrl ?? 'not used')}</dd></div>
      <div><dt>model</dt><dd>${esc(data.model)}</dd></div>
      <div><dt>endpoint</dt><dd>${esc(data.endpoint)}</dd></div>
      <div><dt>runs per arm</dt><dd>${esc(String(data.repeats))}</dd></div>
      <div><dt>workloads</dt><dd>${s.rows.length}</dd></div>
      <div><dt>ran at</dt><dd>${esc(data.ranAt)}</dd></div>
      ${prov.optimizerVersion ? `<div><dt>optimizer build</dt><dd>${esc(prov.optimizerVersion)}</dd></div>` : ''}
    </dl>
  </header>

  <section class="caveat">
    <p><strong>This proves per request. It does not prove per session.</strong></p>
    <p>Every number here compares one request sent twice. A live agent reacts to what changed and may take a different number of turns, so a per-request saving is not a session-level saving. Measuring that needs weeks of your real traffic — it is what the gateway's audited holdout is for.</p>
    <p>Both runs went straight from this machine to your provider. The optimizer ran locally, and no prompt on this page was sent to Anyray.</p>
  </section>

  <div class="verdicts">
    ${costPanel(s)}
    ${qualityPanel(s)}
  </div>

  <section>
    <h2>Per workload</h2>
    <p class="eyebrow section-note">Same model, same key, same path. One header is the only difference.</p>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>Workload</th><th class="num">Baseline</th><th class="num">Optimized</th>
          <th class="num">Saved</th><th class="num">Facts kept</th><th>Strategies</th>
        </tr></thead>
        <tbody>${tableRows(s.rows)}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Both answers</h2>
    <p class="eyebrow section-note">First successful run of each arm.</p>
    ${answerBlocks(s.rows)}
  </section>

  <footer>
    <p>Token counts come from the provider's <code>usage</code> field on both runs. Required facts are the ones each workload declares in <code>mustInclude</code> — your definition of a correct answer, not ours. A workload counts as a regression only when a fact survived without Anyray and stopped surviving with it.</p>
    <p>Want numbers you can check against ours instead of numbers from your own traffic? <a href="https://github.com/anyrayHQ/benchmarks">anyrayHQ/benchmarks</a> commits its results so anyone reproduces them.</p>
  </footer>
</div>
`;
}

function main() {
  const file = process.argv.includes('--in') ? process.argv[process.argv.indexOf('--in') + 1] : 'results.json';
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'report.html';
  if (!existsSync(file)) {
    console.error(`${file} not found — run \`node prove.mjs\` first.`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(out, renderReport(data));
  console.log(`Wrote ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
