#!/usr/bin/env node
// qsim：QuestAway 统一模拟器。一个浏览器、多个页面并行，带结果缓存和误差估计。
// 用法：node qsim.js job.json [--workers 4] [--out result.json] [--no-cache] [--quiet]
// job.json 见 README.md。
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { pathToFileURL } = require('url');

const HERE = __dirname;
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const VALUE_FLAGS = ['--workers', '--out'];
const jobFile = args.find((a, i) => !a.startsWith('--') && a.endsWith('.json') && !VALUE_FLAGS.includes(args[i - 1]));
if (!jobFile) { console.error('用法：node qsim.js job.json [--workers N] [--out file] [--no-cache]'); process.exit(2); }
const W = Math.max(1, Math.floor(+flag('workers', 4)) || 1), USE_CACHE = !flag('no-cache', false), QUIET = !!flag('quiet', false);
const sha = s => crypto.createHash('sha1').update(s).digest('hex');
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;   // 没有数据就是 NaN，不当成 0
const se = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1) / a.length); };

const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
const jobDir = path.dirname(path.resolve(jobFile));
const rel = p => path.isAbsolute(p) ? p : path.resolve(jobDir, p);
const ENGINE = rel(job.engine || path.join(HERE, 'engine.html'));
const saveRaw = fs.readFileSync(rel(job.save), 'utf8');
const game = JSON.parse(JSON.parse(saveRaw).game).game;
const compName = job.companions === undefined ? 'cal' : job.companions;
// 内置口径：脚本目录下有 comp_<名字>.json 就用它（cal、real、synth、strong、cal_wz60 等），否则当作文件路径
const builtinComp = n => /^[\w-]+$/.test(n) && fs.existsSync(path.join(HERE, `comp_${n}.json`)) ? path.join(HERE, `comp_${n}.json`) : null;
const compFile = compName === 'none' ? null : (builtinComp(compName) || rel(compName));
const comp = compFile ? JSON.parse(fs.readFileSync(compFile, 'utf8')) : [];
const pageLib = fs.readFileSync(path.join(HERE, 'page.js'), 'utf8');
const st = fs.statSync(ENGINE);
const BASEKEY = sha([sha(saveRaw), ENGINE, st.size, st.mtimeMs, sha(JSON.stringify(comp)), sha(pageLib)].join('|'));

// ---- 缓存
const CACHE_FILE = path.join(HERE, 'cache.jsonl'); const cache = new Map(); const BASETAG = BASEKEY.slice(0, 12);
const CACHE_PRUNE_BYTES = 64 * 1024 * 1024;   // 超过这个大小就只留当前存档 + 引擎的条目
if (USE_CACHE && fs.existsSync(CACHE_FILE)) {
  const big = fs.statSync(CACHE_FILE).size > CACHE_PRUNE_BYTES, kept = [];
  for (const l of fs.readFileSync(CACHE_FILE, 'utf8').split('\n')) if (l) { try { const [k, v, tag] = JSON.parse(l); if (big && tag !== BASETAG) continue; cache.set(k, v); if (big) kept.push(l); } catch (e) { } }
  if (big) fs.writeFileSync(CACHE_FILE, kept.length ? kept.join('\n') + '\n' : '');
}
const cacheOut = USE_CACHE ? fs.createWriteStream(CACHE_FILE, { flags: 'a' }) : null;

// ---- 展开任务
const variants = job.variants && job.variants.length ? job.variants : [{ name: 'base', ops: [] }];
const D = { colForca: 2200, colDur: 1800000, colCompn: 5, colPreset: '巨像', farmPreset: '推图' };   // 默认口径，见 README
const presetOf = (m, d) => m.preset === undefined ? d : (m.preset || null);   // 不写用默认，写 null 用存档当前配法
const tasks = [], notes = [];
// 巨像样本数：默认 3。指定了 cacada 就是同一场，只算 1 个样本；场次编号 24 个一轮，超过就重复。
const colSamples = (m, mi) => { const want = m.samples || 3; const n = m.cacada ? 1 : Math.min(want, 24); if (n !== want) notes[mi] = m.cacada ? `指定了 cacada，${want} 个样本会是同一场，只算 1 个` : `样本数上限 24（再多会重复同一场），${want} 个按 24 个算`; return n; };
variants.forEach((v, vi) => (job.measures || []).forEach((m, mi) => {
  const ops = v.ops || [];
  if (m.type === 'farm') for (let seed = 0; seed < (m.seeds || 6); seed++) tasks.push({ vi, mi, fn: 'farm', ops, p: { stage: m.stage, seed, overhead: m.overhead, buffs: m.buffs, preset: presetOf(m, D.farmPreset) }, cost: 0.4 });
  else if (m.type === 'col') for (let sample = 0, nS = colSamples(m, mi); sample < nS; sample++) for (const tipo of (m.tipos || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    tasks.push({ vi, mi, fn: 'col', ops, p: { tipo, sample, forca: m.forca ?? D.colForca, dur: m.dur ?? D.colDur, compn: m.compn ?? D.colCompn, preset: presetOf(m, D.colPreset), cacada: m.cacada }, cost: 1.5 });
  else if (m.type === 'boss') for (let seed = 1; seed <= (m.n || 10); seed++) tasks.push({ vi, mi, fn: 'boss', ops, p: { act: m.act, seed, preset: m.preset || null }, cost: 0.3 });
  else if (m.type === 'stats') tasks.push({ vi, mi, fn: 'stats', ops, p: { hero: m.hero, keys: m.keys, preset: m.preset || null }, cost: 0.05 });
  else if (m.type === 'valid') tasks.push({ vi, mi, fn: 'valid', ops, p: { hero: m.hero }, cost: 0.05 });
  else throw new Error('未知测量类型: ' + m.type);
}));
for (const t of tasks) { t.key = sha(BASEKEY + t.fn + JSON.stringify(t.ops) + JSON.stringify(t.p)); if (cache.has(t.key)) t.res = cache.get(t.key); }
const todo = tasks.filter(t => t.res === undefined);

let browser = null;
const closeCache = () => new Promise(res => { if (!cacheOut || cacheOut.closed || cacheOut.writableEnded) return res(); cacheOut.end(res); });
(async () => {
  const t0 = Date.now();
  if (todo.length) {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ offline: true });
    await ctx.route('**/*', r => r.request().url().startsWith('file://') ? r.continue() : r.abort());
    const n = Math.min(W, todo.length);
    const pages = await Promise.all(Array.from({ length: n }, async () => {
      const p = await ctx.newPage(); await p.goto(pathToFileURL(ENGINE).href, { waitUntil: 'load', timeout: 180000 });
      await p.waitForFunction(() => window.__NS && window.__QA, null, { timeout: 60000 });
      await p.evaluate(({ g, comp }) => { window.__g = g; window.__comp = comp; }, { g: game, comp });
      await p.evaluate(pageLib); return p;
    }));
    const tInit = Date.now();
    todo.sort((a, b) => b.cost - a.cost); let next = 0, done = 0;
    await Promise.all(pages.map(async p => {
      while (next < todo.length) {
        const batch = []; let c = 0; while (next < todo.length && c < 6 && batch.length < 24) { const t = todo[next++]; batch.push(t); c += t.cost; }
        const rs = await p.evaluate(b => b.map(t => { try { return { ok: window.QS[t.fn](t.ops, t.p) }; } catch (e) { return { err: String(e && e.message || e).slice(0, 300) }; } }),
          batch.map(t => ({ fn: t.fn, ops: t.ops, p: t.p })));
        rs.forEach((r, i) => { batch[i].res = r; if (cacheOut && r.ok) cacheOut.write(JSON.stringify([batch[i].key, r, BASETAG]) + '\n'); });
        done += batch.length; if (!QUIET && process.stderr.isTTY) process.stderr.write(`\r  ${done}/${todo.length} 个任务`);
      }
    }));
    if (!QUIET) process.stderr.write(`${process.stderr.isTTY ? '\r' : ''}  ${todo.length} 个任务完成：启动 ${((tInit - t0) / 1000).toFixed(1)}s，计算 ${((Date.now() - tInit) / 1000).toFixed(1)}s，缓存命中 ${tasks.length - todo.length} 个\n`);
    await browser.close(); browser = null;
  } else if (!QUIET) process.stderr.write(`  全部 ${tasks.length} 个任务来自缓存\n`);
  await closeCache();

  // ---- 汇总
  const errs = tasks.filter(t => !t.res || !t.res.ok);
  const errLines = []; { const seen = new Map(); for (const t of errs) { const k = `${variants[t.vi].name}｜${t.fn}｜${t.res ? t.res.err : '没有结果'}`; seen.set(k, (seen.get(k) || 0) + 1); }
    for (const [k, n] of seen) errLines.push(`!! ${k} ×${n}`); }
  const reportErrs = () => { if (!errs.length) return; const msg = [`!! ${errs.length} 个任务出错，相关方案的结果不完整：`, ...errLines.slice(0, 12), ...(errLines.length > 12 ? [`!! ……还有 ${errLines.length - 12} 种`] : [])].join('\n'); console.log(msg); console.error(msg); process.exitCode = 1; };
  reportErrs();
  const missing = (vi, mi) => tasks.filter(t => t.vi === vi && t.mi === mi && !(t.res && t.res.ok)).length;
  const lacks = (vi, mi) => { const n = missing(vi, mi); return n ? `   ⚠ 缺 ${n} 个任务` : ''; };
  const out = { job: path.basename(jobFile), save: job.save, measures: [] };
  const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
  const pm = (e, f) => Number.isFinite(e) ? ' ±' + f(e) : '';   // 只有 1 个样本时没有误差，不打印 ±NaN
  (job.measures || []).forEach((m, mi) => {
    const rows = [], noPreset = new Set();
    variants.forEach((v, vi) => {
      const ts = tasks.filter(t => t.vi === vi && t.mi === mi && t.res && t.res.ok).map(t => ({ p: t.p, r: t.res.ok }));
      for (const t of ts) for (const c of t.r.noPreset || []) noPreset.add(c);
      if (m.type === 'farm') rows.push({ name: v.name, vi, by: new Map(ts.map(t => [t.p.seed, t.r.xp])), gby: new Map(ts.map(t => [t.p.seed, t.r.gold])), xs: ts.map(t => t.r.xp), gs: ts.map(t => t.r.gold), fight: mean(ts.map(t => t.r.fight)), down: ts.reduce((a, t) => a + t.r.down, 0), at: [...new Set(ts.map(t => t.r.at).filter(Boolean))] });
      else if (m.type === 'col') { const by = {}; for (const t of ts) (by[t.p.sample] = by[t.p.sample] || []).push(t.r); const ss = Object.keys(by).sort((a, b) => a - b).filter(k => by[k].length === (m.tipos || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).length);
        const tot = k => by[k].reduce((a, r) => a + r.dano, 0);
        rows.push({ name: v.name, vi, by: new Map(ss.map(k => [+k, tot(k)])), xs: ss.map(tot), quedas: mean(ss.map(k => by[k].reduce((a, r) => a + r.quedas, 0))), lutaMs: ts.length ? ts[0].r.lutaMs : 0 }); }
      else if (m.type === 'boss') rows.push({ name: v.name, vi, wins: ts.reduce((a, t) => a + t.r.win, 0), n: ts.length, dmg: mean(ts.map(t => t.r.dmg)), secs: mean(ts.map(t => t.r.secs)) });
      else if (m.type === 'stats' || m.type === 'valid') rows.push({ name: v.name, vi, stats: ts[0] ? ts[0].r : {} });
    });
    const base = rows[0]; const title = m.type === 'farm' ? `刷图 ${m.stage.join('-')}（每人每小时经验，${m.buffs === false ? '不含' : '含'}药水，预设 ${presetOf(m, D.farmPreset) || '当前'}）` : m.type === 'col' ? `巨像（${(m.tipos || []).length || 10} 种合计，强度 ${m.forca ?? D.colForca}，${Math.round((m.dur ?? D.colDur) / 1000)} 秒，同行 ${m.compn ?? D.colCompn} 队，预设 ${presetOf(m, D.colPreset) || '当前'}）` : m.type === 'boss' ? `首领 ${m.act.join('-')}-10` : m.type === 'valid' ? `配法校验 ${m.hero}` : `属性 ${m.hero}`;
    console.log('\n== ' + title);
    if (noPreset.size) console.log(`   （没有这个预设、沿用存档当前配法：${[...noPreset].join('、')}）`);
    if (notes[mi]) console.log(`   （${notes[mi]}）`);
    const o = { type: m.type, title, rows: [] };
    for (const r of rows) {
      if (m.type === 'farm' || m.type === 'col') {
        const dx = []; for (const [key, x] of r.by) if (base.by.has(key) && base.by.get(key) > 0) dx.push(x / base.by.get(key) - 1);   // 只拿种子（样本号）相同的配对
        const mu = mean(r.xs), e = se(r.xs), d = mean(dx), de = se(dx); const unit = m.type === 'farm' ? 1e6 : 1e9, u = m.type === 'farm' ? 'M' : 'B';
        if (!r.xs.length) { console.log(`${r.name.padEnd(30)} （没有结果）${lacks(r.vi, mi)}`); o.rows.push({ name: r.name, mean: null, n: 0, missing: missing(r.vi, mi) }); continue; }
        let line = `${r.name.padEnd(30)} ${(mu / unit).toFixed(1).padStart(8)}${u}${pm(e, x => (x / unit).toFixed(1))}`;
        const noPair = r !== base && !dx.length;   // 基准没有可配对的样本：不能写成 +0.0%
        if (r !== base) line += noPair ? '   （基准没有可比的样本）' : `   ${pct(d).padStart(7)}${pm(de, x => (x * 100).toFixed(1))}`;
        if (m.type === 'farm') { const gx = []; for (const [key, x] of r.gby) if (base.gby.has(key) && base.gby.get(key) > 0) gx.push(x / base.gby.get(key) - 1);   // 金币也只拿同一个种子配对
          line += `   金币 ${(mean(r.gs) / 1e6).toFixed(2)}M${r !== base && gx.length ? ' ' + pct(mean(gx)) : ''}   过图 ${r.fight.toFixed(0)}s${r.down ? '  有人倒地×' + r.down : ''}${r.at.length ? '（退到 ' + r.at.join('、') + '，数字是那一关的）' : ''}`; }
        else line += `   倒地 ${r.quedas.toFixed(0)}`;
        line += lacks(r.vi, mi);
        console.log(line); o.rows.push({ name: r.name, mean: mu, se: e, delta: r === base ? 0 : (dx.length ? d : null), deltaSe: r === base ? 0 : (dx.length > 1 ? de : null), n: r.xs.length, pairs: dx.length, missing: missing(r.vi, mi), gold: m.type === 'farm' ? mean(r.gs) : undefined });
      } else if (m.type === 'boss') { console.log(`${r.name.padEnd(30)} 胜 ${r.wins}/${r.n}   打掉 ${(r.dmg * 100).toFixed(1)}%   ${r.secs.toFixed(1)}s${lacks(r.vi, mi)}`); o.rows.push(r); }
      else { console.log(r.name.padEnd(30), JSON.stringify(r.stats) + lacks(r.vi, mi)); o.rows.push(r); }
    }
    out.measures.push(o);
  });
  if (errs.length) out.errors = errLines;
  const outFile = flag('out', null); if (outFile && outFile !== true) fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  if (errs.length) console.log(`\n!! 有 ${errs.length} 个任务出错（见开头的列表），退出码 1`);
  if (!QUIET) process.stderr.write(`  总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
})().catch(async e => {
  // 中途出错（页面崩溃、导航超时）：先把已算好的结果写进缓存、关掉浏览器再退出，重跑时不用重算
  console.error(e); process.exitCode = 1;
  try { await closeCache(); } catch (_) { }
  try { if (browser) await browser.close(); } catch (_) { }
});
