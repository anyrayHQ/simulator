#!/usr/bin/env node
// Writes report.html from results.json: both verdicts, the per-workload numbers,
// which strategies fired, and both answers side by side.
//
//   node prove.mjs && node report.mjs
//   node report.mjs --redact          -> report-shareable.html
//
// The full report holds your prompts and both models' answers, so it is
// gitignored and meant to stay on this machine. But the reason anyone runs this
// is usually that someone ELSE asked whether the savings are real, and emailing
// them a file full of production prompts is a poor way to answer. --redact
// writes the same numbers with the content removed: no prompts, no answers, and
// no required-fact strings, since a fact is a verbatim value out of the
// customer's own data. What stays is listed in the file's own banner, because
// the sender should be told what they are forwarding rather than reassured.

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
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 68rem; margin: 0 auto; padding: 3rem 1.5rem 5rem; display: flex; flex-direction: column; gap: 2.5rem; }
h1, h2, h3 { text-wrap: balance; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
h1 { font-size: 1.9rem; }
h2 { font-size: 1.05rem; }
p { margin: 0; max-width: 62ch; }
code, .mono, td.num, th.num { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }

.eyebrow {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-soft);
}

/* Masthead — the run slip: what was measured, where, how many times. */
.masthead { display: flex; flex-direction: column; gap: 1rem; border-bottom: 2px solid var(--rule-strong); padding-bottom: 1.5rem; }
.slip { display: flex; flex-wrap: wrap; gap: 0 2rem; font-size: 0.82rem; }
.slip div { display: flex; gap: 0.5rem; padding: 0.15rem 0; }
.slip dt { color: var(--ink-soft); }
.slip dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

.caveat.redacted { border-left-color: var(--warn); background: var(--warn-wash); padding: 1rem 0 1rem 1.1rem; }
.caveat { border-left: 3px solid var(--accent); padding: 0.1rem 0 0.1rem 1.1rem; display: flex; flex-direction: column; gap: 0.5rem; }
.caveat strong { font-weight: 600; }

.verdicts { display: grid; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); gap: 1.25rem; }
.verdict { background: var(--panel); border: 1px solid var(--rule); padding: 1.4rem; display: flex; flex-direction: column; gap: 0.7rem; }
.verdict .headline { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 1.7rem; font-variant-numeric: tabular-nums; line-height: 1.2; }
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
.tag { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.72rem; color: var(--ink-soft); }

details { border: 1px solid var(--rule); background: var(--panel); }
details + details { border-top: none; }
summary { cursor: pointer; padding: 0.7rem 0.9rem; font-size: 0.87rem; display: flex; gap: 0.75rem; align-items: baseline; }
summary::-webkit-details-marker { color: var(--ink-soft); }
summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.answers { display: grid; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); gap: 1px; background: var(--rule); border-top: 1px solid var(--rule); }
.answer { background: var(--panel); padding: 0.9rem; display: flex; flex-direction: column; gap: 0.5rem; }
.answer pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.78rem; line-height: 1.5; max-height: 26rem; overflow-y: auto; }

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
      // `priced` and the dollar figures are computed together by summarize(),
      // but this file re-renders whatever results.json holds — including a file
      // that was hand-edited or written by an older build. Require BOTH before
      // printing money, so a stale or doctored `priced: true` cannot put a
      // dollar figure under a model nobody published a rate for.
      cost.priced && cost.beforeUSD != null && cost.afterUSD != null
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

function qualityPanel(s, redact) {
  const q = s.quality;
  if (q.regressions.length) {
    return `<section class="verdict fail">
      <span class="eyebrow">2 — Quality</span>
      <p class="headline fail-text">${q.regressions.length} of ${q.checked}<br>lost a fact</p>
      <p class="basis">These workloads carried the required fact <strong>without</strong> Anyray and stopped carrying it <strong>with</strong> Anyray:</p>
      <ul class="basis">${q.regressions
        .map((r) =>
          redact
            ? `<li><code>${esc(r.id)}</code> — ${r.facts.lost.length} of ${r.facts.total} required fact(s)</li>`
            : `<li><code>${esc(r.id)}</code> — ${esc(r.facts.lost.join(', '))}</li>`
        )
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

function tableRows(rows, redact) {
  return rows
    .map((r) => {
      if (!r.bypassed || !r.optimized) {
        return `<tr><td><code>${esc(r.id)}</code></td><td colspan="5" class="flag">${esc(r.errors[0] ?? 'no successful runs')}</td></tr>`;
      }
      const flags = [];
      // A required fact is a verbatim string out of the customer's own data —
      // an order id, a service name. In a shareable report it becomes a count.
      if (r.facts.regression) {
        flags.push(
          redact
            ? `<span class="flag">${r.facts.lost.length} required fact(s) lost after the trim</span>`
            : `<span class="flag">only missing after the trim: ${esc(r.facts.lost.join(', '))}</span>`
        );
      }
      if (r.facts.inconclusive && !r.facts.regression) {
        flags.push(
          redact
            ? `<span class="flag mild">${r.facts.missingBoth.length} fact(s) missing from both answers, so not counted</span>`
            : `<span class="flag mild">missing from both answers, so not counted: ${esc(r.facts.missingBoth.join(', '))}</span>`
        );
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
        <div class="answer"><span class="eyebrow">Anyray off</span><pre>${esc(r.answers.bypassed ?? '(no answer)')}</pre></div>
        <div class="answer"><span class="eyebrow">Anyray on</span><pre>${esc(r.answers.optimized ?? '(no answer)')}</pre></div>
      </div>
    </details>`
    )
    .join('\n');
}

export function renderReport(data, { redact = false } = {}) {
  const s = data.summary;
  let host = data.gatewayUrl;
  try {
    host = new URL(data.gatewayUrl).host;
  } catch {
    /* a non-URL gateway string still prints fine as-is */
  }
  // NO EXTERNAL RESOURCES, DELIBERATELY.
  //
  // This page holds the customer's prompts and both models' answers. An earlier
  // version pulled webfonts from Google, which meant opening the report made a
  // request to a third party from inside their network, with the report's URL
  // in the referer — on a page we told them never leaves their machine. A nicer
  // typeface is not worth a request they did not ask for and we did not
  // disclose. System fonts only.
  return `<title>Anyray Simulator · ${esc(host)}${redact ? ' · shareable' : ''}</title>
<style>${STYLE}</style>
<div class="wrap">
  <header class="masthead">
    <span class="eyebrow">Anyray simulator run</span>
    <h1>Two verdicts on your own prompts</h1>
    <dl class="slip">
      <div><dt>gateway</dt><dd>${esc(host)}</dd></div>
      <div><dt>model</dt><dd>${esc(data.model)}</dd></div>
      <div><dt>endpoint</dt><dd>${esc(data.endpoint)}</dd></div>
      <div><dt>runs per arm</dt><dd>${esc(String(data.repeats))}</dd></div>
      <div><dt>workloads</dt><dd>${s.rows.length}</dd></div>
      <div><dt>ran at</dt><dd>${esc(data.ranAt)}</dd></div>
    </dl>
  </header>

  ${
    redact
      ? `<section class="caveat redacted">
    <p><strong>Shareable copy — prompts and answers removed.</strong></p>
    <p>This version carries the numbers and none of the content: no prompts, no model answers, and no required-fact strings (those are verbatim values out of your own data, so they are shown as counts).</p>
    <p><strong>Still in this file, so check before you send it:</strong> your workload ids, your gateway host, your model name, and the token counts themselves. Workload ids are kept because a reader has to be able to refer to a row — if one of yours names something you would rather not share, rename the file in <code>workloads/</code> and re-run the report.</p>
    <p>The full version, with both answers side by side, is in <code>report.html</code> and stays on this machine.</p>
  </section>`
      : ''
  }

  <section class="caveat">
    <p><strong>This proves per request. It does not prove per session.</strong></p>
    <p>Every number here compares one request sent twice. A live agent reacts to what changed and may take a different number of turns, so a per-request saving is not a session-level saving. Measuring that needs weeks of your real traffic — it is what the gateway's audited holdout is for.</p>
  </section>

  <div class="verdicts">
    ${costPanel(s)}
    ${qualityPanel(s, redact)}
  </div>

  <section>
    <h2>Per workload</h2>
    <p class="eyebrow section-note">Same model, same key, same path. One header is the only difference.</p>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>Workload</th><th class="num">Anyray off</th><th class="num">Anyray on</th>
          <th class="num">Saved</th><th class="num">Facts kept</th><th>Strategies</th>
        </tr></thead>
        <tbody>${tableRows(s.rows, redact)}</tbody>
      </table>
    </div>
  </section>

  ${
    redact
      ? ''
      : `<section>
    <h2>Both answers</h2>
    <p class="eyebrow section-note">First successful run of each arm.</p>
    ${answerBlocks(s.rows)}
  </section>`
  }

  <footer>
    <p>Token counts come from the provider's <code>usage</code> field on both runs. Required facts are the ones each workload declares in <code>mustInclude</code> — your definition of a correct answer, not ours. A workload counts as a regression only when a fact survived without Anyray and stopped surviving with it.</p>
    <p>Want numbers you can check against ours instead of numbers from your own traffic? <a href="https://github.com/anyrayHQ/benchmarks">anyrayHQ/benchmarks</a> commits its results so anyone reproduces them.</p>
  </footer>
</div>
`;
}

function main() {
  const file = process.argv.includes('--in') ? process.argv[process.argv.indexOf('--in') + 1] : 'results.json';
  const redact = process.argv.includes('--redact');
  const out = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : redact
      ? 'report-shareable.html'
      : 'report.html';
  if (!existsSync(file)) {
    console.error(`${file} not found — run \`node prove.mjs\` first.`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(out, renderReport(data, { redact }));
  console.log(
    redact
      ? `Wrote ${out} — numbers only. Prompts, answers and fact strings removed; workload ids, gateway host and model name kept. Read it before you send it.`
      : `Wrote ${out}. For a copy you can send on, run: node report.mjs --redact`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
