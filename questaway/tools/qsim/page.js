// qsim 页面内库：在游戏引擎页面里运行，只依赖引擎自己的函数。
// window.__NS 是引擎的具名导出表；window.__QA 里只用到一个没有具名导出的函数（est2）。
(() => {
  const NS = window.__NS, Q = window.__QA || {};
  const clone = o => JSON.parse(JSON.stringify(o));
  const allHeroes = g => [...g.heroes, ...(g.bench || [])];
  const heroOf = (g, cls) => { const h = allHeroes(g).find(h => h.classId === cls); if (!h) throw new Error('没有这个职业: ' + cls); return h; };
  const RAR = r => NS.rarityById(r);
  const itemOf = (g, cls, slot) => { const it = heroOf(g, cls).equipment[slot]; if (!it) throw new Error(`这个部位没有装备: ${cls}.${slot}`); return it; };

  function applyPreset(h, name) {
    const p = (h.buildPresets || []).find(p => p && p.name === name);
    if (!p) return false;
    h.treeNodes = [...p.treeNodes];
    if (p.abilityRanks) h.abilityRanks = { ...p.abilityRanks };
    h.activeSkills = [...p.activeSkills];
    return true;
  }
  // 给全队套同名预设，返回没有这个预设、沿用存档当前配法的职业。
  function applyPresetAll(s, name) {
    const miss = []; if (name) for (const h of s.heroes) if (!applyPreset(h, name)) miss.push(h.classId);
    return miss;
  }

  // 一件装备的附魔是几阶卷轴：有记录用记录，没有就按数值反推（生成的装备不带这个字段）。
  function enchantTier(it) {
    if (!it.enchant) return null;
    if (it.enchantScrollTier) return it.enchantScrollTier;
    const R = RAR(it.rarity); let best = 5, err = Infinity;
    for (let t = 1; t <= 5; t++) { const e = Math.abs(NS.valorDoPergaminho(it.enchant.stat, it.itemLevel, R, t) - it.enchant.value); if (e < err) { err = e; best = t; } }
    return best;
  }

  // 用引擎自己的公式生成一件装备：词条取底材的前 N 条，数值、孔数、附魔都由引擎算。
  function makeItem(tpl, spec) {
    const it = clone(tpl), tplTier = enchantTier(tpl);
    const baseId = spec.base || it.baseType;
    const base = NS.catalogBaseById(baseId);
    if (!base) throw new Error('没有这个底材: ' + baseId);
    const rarity = spec.rarity || it.rarity, il = spec.level || it.itemLevel, R = RAR(rarity);
    it.baseType = baseId; it.rarity = rarity; it.itemLevel = il;
    it.affixes = base.affixes.slice(0, R.affixCount).map(stat => ({ stat, value: NS.affixValue(stat, il, R) }));
    it.enhancement = spec.enhance || 0;
    delete it.enhancementXp; delete it.marcosDespertos;
    if (it.enhancement > 0) it.marcosDespertos = spec.awake || 0;
    // 孔
    const cap = NS.socketCap(it);
    let gems = spec.sockets !== undefined ? spec.sockets : (it.sockets || []);
    if (typeof gems === 'string') gems = Array(cap).fill(gems);
    gems = gems.slice(0, cap); while (gems.length < cap) gems.push(spec.sockets === undefined && gems.length ? gems[gems.length - 1] : null);
    it.sockets = gems;
    // 附魔：数值跟装备等级、品质、卷轴阶数走。没指定时沿用模板原来的属性和阶数，不顺手升阶。
    let en = spec.enchant !== undefined ? spec.enchant : (it.enchant ? { stat: it.enchant.stat, tier: tplTier } : null);
    if (it.infusao && spec.enchant === undefined) en = null;
    if (en) { const tier = en.tier || 5; it.enchant = { stat: en.stat, value: NS.valorDoPergaminho(en.stat, il, R, tier) }; it.enchantScrollTier = tier; }
    else { delete it.enchant; delete it.enchantScrollTier; }
    return it;
  }

  const OPS = {
    preset(g, o) { for (const h of g.heroes) if (o.hero === '*' || o.hero === h.classId || (Array.isArray(o.hero) && o.hero.includes(h.classId))) applyPreset(h, o.name); },
    enhance(g, o) { const it = itemOf(g, o.hero, o.slot); it.enhancement = o.level; it.marcosDespertos = o.awake || 0; delete it.enhancementXp; },
    item(g, o) { const h = heroOf(g, o.hero); const tpl = h.equipment[o.slot] || { id: 'qs_' + o.slot, slot: o.slot, sockets: [], affixes: [], value: 1, marketable: false }; h.equipment[o.slot] = makeItem(tpl, o); },
    gems(g, o) { const it = itemOf(g, o.hero, o.slot); it.sockets = typeof o.gems === 'string' ? it.sockets.map(() => o.gems) : o.gems; },
    enchant(g, o) { const it = itemOf(g, o.hero, o.slot); const tier = o.tier || 5; it.enchant = { stat: o.stat, value: NS.valorDoPergaminho(o.stat, it.itemLevel, RAR(it.rarity), tier) }; it.enchantScrollTier = tier; },
    level(g, o) { for (const h of allHeroes(g)) if (o.hero === '*' || o.hero === h.classId) h.level = o.level; },
    buff(g, o) { g.buffs = o.id ? [{ id: o.id, msRemaining: 7200000, durationId: '8h' }] : []; },
    bestiary(g, o) { Object.assign(g.sim.abatesDoBestiario, o.kills); },
    talisman(g, o) { const t = { menores: [], maior: false }; if (o.rarity && o.rarity !== 'eternal') t.raridade = o.rarity; g.circulo.encaixados[String(o.tipo)] = t; },
    untalisman(g, o) { delete g.circulo.encaixados[String(o.tipo)]; },
    build(g, o) { const h = heroOf(g, o.hero); if (o.treeNodes) h.treeNodes = o.treeNodes; if (o.addNodes) h.treeNodes = [...h.treeNodes, ...o.addNodes]; if (o.abilityRanks) h.abilityRanks = o.abilityRanks; if (o.activeSkills) h.activeSkills = o.activeSkills; },
    swap(g, o) { // 把替补换上场：{out:'monk', in:'wizard', level:96}
      const i = g.heroes.findIndex(h => h.classId === o.out), j = (g.bench || []).findIndex(h => h.classId === o.in);
      if (i < 0 || j < 0) throw new Error('swap 找不到英雄'); const a = g.heroes[i], b = g.bench[j]; if (o.level) b.level = o.level; g.heroes[i] = b; g.bench[j] = a; },
    hero(g, o) { // 用一份完整的英雄数据顶替场上某人：{out:'monk', hero:{...}}
      const i = g.heroes.findIndex(h => h.classId === o.out); if (i < 0) throw new Error('hero 找不到 ' + o.out);
      const old = g.heroes[i], bench = (g.bench || []).filter(h => h.classId !== o.hero.classId);
      // id 必须全队唯一：和别人撞了（或没带 id）就另起一个
      const used = new Set([...g.heroes.filter((_, j) => j !== i), ...bench, old].map(h => h.id));
      let id = o.hero.id; if (!id || used.has(id)) { id = 'qs_' + o.hero.classId; for (let n = 2; used.has(id); n++) id = 'qs_' + o.hero.classId + n; }
      g.heroes[i] = { ...clone(o.hero), id }; g.bench = [...bench, old]; },
    order(g, o) { // 调整站位：{classes:['priest','thief','engineer','wizard']}，没列出的排在后面。1 号位挨打最多
      const rank = c => { const i = o.classes.indexOf(c); return i < 0 ? 99 : i; }; g.heroes = g.heroes.slice().sort((x, y) => rank(x.classId) - rank(y.classId)); },
    set(g, o) { // 通用：{path:['sim','gold'], value:1}
      let t = g; for (const k of o.path.slice(0, -1)) t = t[k]; t[o.path[o.path.length - 1]] = o.value; },
  };

  function patched(ops) {
    const g = clone(window.__g);
    for (const o of ops || []) { const f = OPS[o.op]; if (!f) throw new Error('未知操作: ' + o.op); f(g, o); }
    return g;
  }
  const idle = g => { delete g.luta; delete g.lutaDaFase; if (g.colosso) delete g.colosso.aqui; return g; };

  // 刷图：一个种子跑 10 分钟。buffs=true 时把药水（洞察等）算进去。
  function farm(ops, p) {
    const s = idle(patched(ops)); const [d, a, st] = p.stage; s.difficulty = d; s.act = a; s.stage = st;
    const noPreset = applyPresetAll(s, p.preset);
    const lv0 = s.heroes.map(h => h.level);
    for (const h of s.heroes) h.xp = 0; s.sim.kills = 1000 + p.seed * 7919;
    const g0 = s.sim.gold, MS = 600000;
    const est = Q.est2(s);   // 有人倒地时引擎会像游戏里一样往回退关，s 的关卡可能已经不是请求的那一关
    const at = [s.difficulty, s.act, s.stage], fell = at.join('-') !== p.stage.join('-');
    const kph = est.abatesPorSegundo * 3600;
    if (!(kph > 0)) return { xp: 0, gold: 0, kph: 0, fight: 0, down: 1, at: at.join('-'), noPreset };   // 打不动
    const kc = NS.abatesDaFaseEm(null, at[0], at[1], at[2]);   // 过图时间按实际停留的那一关算
    if (!(kc > 0)) throw new Error('取不到这一关的击杀数: ' + at.join('-'));
    const mode = p.buffs === false ? { goldMult: 0, xpMult: 0, dropMult: 0 } : NS.buffEconBonus(s.buffs || []);
    const c = NS.currentEncounterParams(s, mode);
    const hv = est.todosDePe && c.heroisVivos ? { heroisVivos: c.heroisVivos.map(() => true) } : {};
    NS.catchUpOffline(s.sim, MS, { ...c, ...hv, killsPerTick: est.abatesPorSegundo * c.msPerTick / 1000, xpPerKill: c.xpPerKill * (1 + est.xpDoExcedente) },
      { capMs: MS, goldEfficiency: 1, xpEfficiency: 1 }, s.heroes);
    const fight = kc / kph * 3600, real = fight + (p.overhead ?? 4), k = fight / real;
    // 这 10 分钟里升了级的英雄，把跨过的每一级所需经验加回来
    const xpEach = s.heroes.map((h, i) => { let x = h.xp; for (let L = lv0[i]; L < h.level; L++) x += NS.xpToNext(L); return x * 6 * k; });
    return { xp: xpEach.reduce((x, y) => x + y, 0) / xpEach.length, gold: (s.sim.gold - g0) * 6 * k, kph, fight, down: est.todosDePe && !fell ? 0 : 1, at: fell ? at.join('-') : undefined, noPreset };
  }

  // 巨像：一种类型打一场。cacada 决定随机种子，同一个 tipo 在日期上每 10 天轮一次。
  const DAY_OF_TYPE = [3, 4, 5, 6, 7, 8, 9, 10, 1, 2];
  const HOURS = ['01', '03', '05', '07', '09', '11', '13', '15', '17', '19', '21', '23'];
  function huntId(tipo, sample) { const day = DAY_OF_TYPE[tipo - 1] + 10 * (Math.floor(sample / 12) % 2); return `2026-11-${String(day).padStart(2, '0')}T${HOURS[sample % 12]}`; }
  function col(ops, p) {
    const s = patched(ops); delete s.colosso; delete s.luta; delete s.lutaDaFase;
    const noPreset = applyPresetAll(s, p.preset);
    const id = p.cacada || huntId(p.tipo, p.sample || 0);
    const rest = p.dur + 10000; const opts = { cacada: id, tipo: p.tipo, restanteMs: rest, faltaMs: 0 };
    if (p.forca && p.forca !== 1000) opts.forca = p.forca;
    const bad = NS.porQueNaoVaiAoColosso(s, opts); if (bad) throw new Error('巨像进不去: ' + bad);
    NS.gameIrAoColosso(s, opts);
    // 同行玩家每场用一份副本，免得引擎改动它们后影响同一页面里的下一场
    const comp = clone((window.__comp || []).slice(0, p.compn ?? 5)); if (comp.length) NS.gameColossoCompanhia(s, comp);
    let left = rest; while (left > 0 && s.colosso && s.colosso.aqui) { NS.avancarNoColosso(s, Math.min(60000, left), false); left -= 60000; }
    const k = s.colosso; return { dano: k.dano, quedas: k.quedas, lutaMs: k.lutaMs, tank: k.tankado || 0, noPreset };
  }

  function boss(ops, p) {
    const s = idle(patched(ops)); const [d, a] = p.act; s.difficulty = d; s.act = a; s.stage = 10;
    const noPreset = applyPresetAll(s, p.preset);
    const x = NS.ensaioDoChefao(s, 1800000, p.seed); return { win: x.vence ? 1 : 0, dmg: x.tirada, secs: x.segundos, noPreset };
  }

  function stats(ops, p) {
    const s = patched(ops); applyPresetAll(s, p.preset);
    const h = heroOf(s, p.hero); const t = NS.heroTotals(h); const out = {}; for (const k of p.keys || Object.keys(t)) if (typeof t[k] === 'number') out[k] = t[k]; return out;
  }

  function valid(ops, p) {
    const s = patched(ops); const h = heroOf(s, p.hero);
    let r = null; try { r = NS.problemaDaBuild(s, h, { treeNodes: h.treeNodes, abilityRanks: h.abilityRanks, activeSkills: h.activeSkills }); } catch (e) { r = 'ERR ' + String(e).slice(0, 80); }
    const pts = Object.values(h.abilityRanks || {}).reduce((a, b) => a + b, 0);
    return { problem: r || null, tree: h.treeNodes.length, treeMax: NS.heroTreePointsAvailable({ ...h, treeNodes: [] }), abil: pts, abilMax: NS.abilityPointsAtLevel(h.level) };
  }

  function info() {
    const g = window.__g; return {
      engine: NS.GAME_VERSION, save: g.version, heroes: g.heroes.map(h => [h.classId, h.level]), stage: [g.difficulty, g.act, g.stage],
      buffs: (g.buffs || []).map(b => b.id), presets: g.heroes.map(h => [h.classId, (h.buildPresets || []).filter(Boolean).map(p => p.name)]),
      colosso: g.colosso ? { cacada: g.colosso.cacada, tipo: g.colosso.tipo, dano: g.colosso.dano, lutaMs: g.colosso.lutaMs, forca: g.colosso.forca, quedas: g.colosso.quedas, companhia: g.colosso.aqui?.companhia?.length ?? null } : null,
    };
  }

  window.QS = { farm, col, boss, stats, valid, info, patched, makeItem, huntId };
})();
