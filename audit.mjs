#!/usr/bin/env node
// Audit session runs against the gateway's own traces: which strategies acted
// on each experiment arm, which stood down, and why.
//
// A client never sees the gateway's per-request decisions, so a run that
// claims "observation_mask alone" has to be checked from the other side. Each
// `anyray:<name>` arm sends as client tool `anyray-simulator-cc-<name>`; this
// reads every trace for those tools since --since and groups the turns by
// arm, context size and cache state (see `bucket`).
//
//   node audit.mjs --since 2026-09-28T21:00Z [--json out.json]   # needs ANYRAY_ADMIN_KEY

import { writeFileSync } from 'node:fs';
import { loadEnv } from './lib/env.mjs';

const arg = (f) => {
  const i = process.argv.indexOf(f);
  return i > 0 ? process.argv[i + 1] : null;
};
const env = loadEnv();
const gw = env.ANYRAY_GATEWAY_URL;
const key = env.ANYRAY_ADMIN_KEY;
if (!key) throw new Error('ANYRAY_ADMIN_KEY is not set');
const start = Date.parse(arg('--since') ?? new Date(Date.now() - 3_600_000).toISOString());
const until = arg('--until') ? Date.parse(arg('--until')) : Infinity;
const auth = { authorization: `Bearer ${key}` };
const PREFIX = 'anyray-simulator-cc-';
const get = async (path) => {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${gw}${path}`, { headers: auth });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw new Error(`GET ${path} failed`);
};

const traces = [];
for (let page = 1; page < 1000; page++) {
  const { data } = await get(`/admin/v1/traces?limit=100&page=${page}`);
  if (!data.length) break;
  for (const t of data) if (Date.parse(t.timestamp) >= start && Date.parse(t.timestamp) <= until && t.metadata?.clientTool?.startsWith(PREFIX)) traces.push(t);
  if (Date.parse(data[data.length - 1].timestamp) < start) break;
}

// The optimizer span holds each strategy's own reasoning, including declines
// the summary never shows (mint_economics: candidates declined below the
// payback gate, with the priced premium and saving).
async function span(t) {
  const d = await get(`/admin/v1/traces/${t.id}`).catch(() => ({}));
  t.decisions = (d.observations ?? []).filter((o) => o.name === 'optimizer').flatMap((o) => o.output?.decisions ?? []);
}
for (let i = 0; i < traces.length; i += 10) await Promise.all(traces.slice(i, i + 10).map(span));

// Bucket every turn by what the gateway itself can see on that request: how
// big the context is, and whether the provider read it from cache (warm) or
// had to bill it again (cold: nothing read, a resent transcript). That is the
// question behind "can we tell when a strategy pays": if firing tracks these
// buckets, the gateway can decide it per request.
const bucket = (m) => {
  const ctx = (m.promptTokens ?? 0) + (m.cacheReadTokens ?? 0) + (m.cacheWriteTokens ?? 0);
  const size = ctx < 20_000 ? '<20k' : ctx < 60_000 ? '20-60k' : '60k+';
  const cache = (m.cacheReadTokens ?? 0) > 1_500 ? 'warm' : 'cold';
  return `${size.padEnd(6)} ${cache}`;
};
const groups = new Map();
for (const t of traces) {
  const k = `anyray:${t.metadata.clientTool.slice(PREFIX.length)}  ${bucket(t.metadata)}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(t);
}
const BOOKKEEPING = new Set(['turn_shape', 'mint_economics']);
let clean = true;
const out = {};
for (const [k, turns] of [...groups].sort()) {
  const want = turns[0].metadata.clientTool.slice(PREFIX.length);
  const acted = {};
  const stood = {};
  let saved = 0;
  let declined = 0;
  const net = [];
  let actedTurns = 0;
  for (const t of turns) {
    const m = t.metadata;
    if ((m.optimizationKinds ?? []).includes(want)) actedTurns++;
    for (const x of m.optimizationKinds ?? []) acted[x] = (acted[x] ?? 0) + 1;
    for (const [kind, rs] of Object.entries(m.strategyDeclines ?? {})) for (const [r, n] of Object.entries(rs)) stood[`${kind}: ${r}`] = (stood[`${kind}: ${r}`] ?? 0) + n;
    for (const s of m.optimizationSuppressed ?? []) if (s.kind !== 'first_appearance_shadow') stood[`${s.kind}: ${s.reason}`] = (stood[`${s.kind}: ${s.reason}`] ?? 0) + 1;
    saved += m.estimatedTokensSaved ?? 0;
    for (const d of t.decisions ?? []) {
      if (d.kind !== 'mint_economics') continue;
      if (/declined/.test(d.summary ?? '')) {
        stood[`mint gate: ${d.summary.replace(/\d+/g, 'N')}`] = (stood[`mint gate: ${d.summary.replace(/\d+/g, 'N')}`] ?? 0) + 1;
        declined += d.metric?.value ?? 0;
      }
      if (d.metric?.name === 'net_expected_saving_usd') net.push(d.metric.value);
    }
  }
  const strays = Object.keys(acted).filter((x) => x !== want && !BOOKKEEPING.has(x));
  if (strays.length) clean = false;
  out[k] = { turns: turns.length, actedTurns, acted, stood, estTokensSaved: saved, mintDeclinedTokens: declined, mintPriced: net.length, mintPositive: net.filter((x) => x > 0).length, strays };
  console.log(`\n${k}   ${turns.length} turns, ${want} acted on ${actedTurns} (${Math.round((100 * actedTurns) / turns.length)}%)`);
  const others = Object.entries(acted).filter(([x]) => x !== want && !BOOKKEEPING.has(x));
  if (others.length) console.log(`  also acted: ${others.map(([x, n]) => `${x} ×${n}`).join(', ')}`);
  console.log(`  est. saved: ${saved.toLocaleString()} tokens (gateway estimate, summed over turns)`);
  if (net.length) console.log(`  mint gate:  priced ${net.length} turn(s), ${net.filter((x) => x > 0).length} with a positive expected saving; ${declined.toLocaleString()} tokens declined as not paying back`);
  const top = Object.entries(stood).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (top.length) console.log(`  stood down: ${top.map(([x, n]) => `${x} ×${n}`).join('\n              ')}`);
  if (strays.length) console.log(`  ! NOT ISOLATED: ${strays.join(', ')} also acted`);
}
console.log(clean ? '\nIsolation holds: no arm had any strategy act other than its own.' : '\nIsolation BROKEN on at least one arm (see above).');
if (arg('--json')) writeFileSync(arg('--json'), JSON.stringify(out, null, 2));
