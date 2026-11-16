/* Groky Desk : tableau de bord temps réel, lecture seule, aucune clé API. */
(() => {
'use strict';

// ---------- configuration ----------
const DEFAULT_WALLET = '4sPACuXcJ3ssYURkuyxHDUsDh39WpEdreDxus2B969rB';
const DEFAULT_BASE = { sol: 1.527, usd: 109.5 };
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const STABLES = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC', Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT' };
const qs = new URLSearchParams(location.search);
// RPC publics sans clé, compatibles CORS. Ordre = priorité. ?rpc=https://... pour en ajouter un en tête.
const RPCS = [qs.get('rpc'), 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
const T_WALLET = 15000, T_PRICES = 20000, T_STATE = 45000, T_SCENE = 5000;
const MAX_POINTS = 6000;
const LS_EQ = 'groky.equity.v1', LS_SOL = 'groky.solpx.v1', LS_PEAK = 'groky.peaks.v1', LS_RANGE = 'groky.range';

// ---------- état ----------
const S = {
  wallet: DEFAULT_WALLET, base: { ...DEFAULT_BASE },
  state: null, stateOk: null, stateLoadedAt: null,
  sol: null, tokens: {}, // mint -> {amount, decimals}
  prices: {}, // mint -> {price, symbol, url, chg, liq}
  rpcIdx: 0, indexedBroken: {}, errors: {}, lastOk: null,
  equity: load(LS_EQ, []), solpx: load(LS_SOL, []), peaks: load(LS_PEAK, {}),
  range: +(localStorage.getItem(LS_RANGE) ?? 3600000),
  seenTrade: null,
};

// ---------- utilitaires ----------
function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DASH = '—';
const fmtUsd = (v, d = 2) => v == null || !isFinite(v) ? DASH : v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }) + '\u00a0$';
const fmtNum = (v, d = 4) => v == null || !isFinite(v) ? DASH : v.toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) });
const fmtPct = (v, d = 2) => v == null || !isFinite(v) ? DASH : (v > 0 ? '+' : '') + v.toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d }) + ' %';
const fmtSigned = v => v == null || !isFinite(v) ? DASH : (v > 0 ? '+' : v < 0 ? '−' : '') + fmtUsd(Math.abs(v));
function fmtPrice(p) {
  if (p == null || !isFinite(p)) return DASH;
  if (p >= 1) return fmtUsd(p, p >= 100 ? 2 : 4);
  const d = Math.min(10, Math.max(4, 2 - Math.floor(Math.log10(p)) + 2));
  return p.toFixed(d).replace('.', ',') + '\u00a0$';
}
const parisFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const parisDT = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const hhmmss = t => parisFmt.format(t);
const dt = iso => { if (!iso) return DASH; const d = new Date(iso); return isNaN(d) ? DASH : parisDT.format(d).replace(' ', ' '); };
function ago(iso) {
  if (!iso) return DASH; const m = (Date.now() - new Date(iso)) / 60000;
  if (!isFinite(m)) return DASH; if (m < 1) return "à l'instant"; if (m < 60) return `il y a ${Math.round(m)} min`;
  if (m < 1440) return `il y a ${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}`; return `il y a ${Math.round(m / 1440)} j`;
}
const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : DASH;
const solscan = a => `https://solscan.io/account/${a}`;
const dexs = m => `https://dexscreener.com/solana/${m}`;

const logEl = () => $('log');
function log(msg, err) {
  const el = logEl(); if (!el) return;
  const line = document.createElement('div'); if (err) line.className = 'e';
  line.textContent = `${hhmmss(new Date())}  ${msg}`; el.prepend(line);
  while (el.childNodes.length > 60) el.lastChild.remove();
}

// nombres animés
const anims = new WeakMap();
function animate(el, to, fmt, dir = true) {
  if (!el) return;
  if (to == null || !isFinite(to)) { el.textContent = DASH; el.dataset.v = ''; return; }
  const from = el.dataset.v === undefined || el.dataset.v === '' ? null : +el.dataset.v;
  el.dataset.v = to;
  if (from == null || from === to) { el.textContent = fmt(to); return; }
  if (dir) { el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth; el.classList.add(to > from ? 'flash-up' : 'flash-down'); }
  const t0 = performance.now(), dur = 700; cancelAnimationFrame(anims.get(el));
  const step = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e); if (k < 1) anims.set(el, requestAnimationFrame(step)); };
  anims.set(el, requestAnimationFrame(step));
}

// ---------- erreurs / indicateur live ----------
function setErr(src, e) {
  if (e) { S.errors[src] = String(e.message || e).slice(0, 90); log(`${src} : échec (${S.errors[src]})`, true); }
  else delete S.errors[src];
  renderLive();
}
function renderLive() {
  const errs = Object.entries(S.errors);
  const dot = $('liveDot'), lbl = $('liveLabel');
  dot.className = 'dot ' + (S.lastOk ? (errs.length ? 'warn' : 'ok') : (errs.length ? 'err' : ''));
  lbl.textContent = S.lastOk ? 'EN DIRECT' : (errs.length ? 'HORS LIGNE' : 'Connexion…');
  $('liveTime').textContent = S.lastOk ? hhmmss(S.lastOk) + ' Paris' : DASH;
  const bar = $('errbar');
  if (errs.length) { bar.hidden = false; bar.textContent = '⚠ ' + errs.map(([k, v]) => `${k} : ${v}`).join(' · ') + ' (nouvel essai auto)'; }
  else bar.hidden = true;
}
const ok = () => { S.lastOk = new Date(); renderLive(); };

// ---------- réseau ----------
async function fetchJson(url, opts = {}, timeout = 10000) {
  const ctl = new AbortController(); const id = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) { if (e.name === 'AbortError') throw new Error('délai dépassé'); throw e; }
  finally { clearTimeout(id); }
}
async function rpcCall(method, params, { indexed = false } = {}) {
  let lastErr;
  for (let i = 0; i < RPCS.length; i++) {
    const idx = (S.rpcIdx + i) % RPCS.length, url = RPCS[idx];
    if (indexed && S.indexedBroken[url] && S.indexedBroken[url] > Date.now()) continue;
    try {
      const j = await fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (j.error) throw new Error(j.error.message || 'erreur RPC');
      if (!indexed) S.rpcIdx = idx;
      return { result: j.result, url };
    } catch (e) {
      lastErr = e;
      if (indexed) S.indexedBroken[url] = Date.now() + 10 * 60000;
    }
  }
  throw lastErr || new Error('aucun RPC disponible');
}

// ---------- wallet ----------
async function refreshWallet() {
  try {
    const { result, url } = await rpcCall('getBalance', [S.wallet]);
    S.sol = result.value / 1e9;
    const tokens = {};
    let gotTokens = false;
    try { // appel indexé (souvent refusé par les RPC publics) puis repli sur les comptes connus
      for (const prog of TOKEN_PROGRAMS) {
        const r = await rpcCall('getTokenAccountsByOwner', [S.wallet, { programId: prog }, { encoding: 'jsonParsed' }], { indexed: true });
        for (const a of r.result.value) addTok(tokens, a.account.data.parsed.info);
      }
      gotTokens = true;
    } catch {}
    const known = (S.state?.token_accounts || []).map(a => a.account);
    if (!gotTokens && known.length) {
      const r = await rpcCall('getMultipleAccounts', [known.slice(0, 100), { encoding: 'jsonParsed' }]);
      for (const a of r.result.value) if (a?.data?.parsed?.info) addTok(tokens, a.data.parsed.info);
      gotTokens = true;
    }
    if (gotTokens) S.tokens = tokens;
    setErr('RPC Solana', null);
    log(`Solde lu via ${new URL(url).host} : ${fmtNum(S.sol, 6)} SOL, ${Object.keys(S.tokens).length} token(s)`);
    ok(); render(); recordPoint();
  } catch (e) { setErr('RPC Solana', e); }
}
function addTok(map, info) {
  const amt = +info.tokenAmount.uiAmountString;
  if (!amt) return;
  map[info.mint] = { amount: (map[info.mint]?.amount || 0) + amt, decimals: info.tokenAmount.decimals };
}

// ---------- prix ----------
async function refreshPrices() {
  const mints = new Set([SOL_MINT]);
  Object.keys(S.tokens).forEach(m => mints.add(m));
  (S.state?.positions || []).forEach(p => p.mint && mints.add(p.mint));
  const list = [...mints];
  try {
    for (let i = 0; i < list.length; i += 30) {
      const chunk = list.slice(i, i + 30);
      const pairs = await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`);
      const best = {};
      for (const p of pairs || []) {
        const m = p.baseToken?.address; if (!chunk.includes(m)) continue;
        if (m === SOL_MINT && !['USDC', 'USDT'].includes(p.quoteToken?.symbol)) continue;
        if (!best[m] || (p.liquidity?.usd || 0) > (best[m].liquidity?.usd || 0)) best[m] = p;
      }
      for (const [m, p] of Object.entries(best)) {
        S.prices[m] = { price: +p.priceUsd, symbol: p.baseToken.symbol, name: p.baseToken.name, url: p.url, chg: p.priceChange || {}, liq: p.liquidity?.usd, dex: p.dexId, quote: p.quoteToken?.symbol, img: p.info?.imageUrl };
        trackPeak(m, +p.priceUsd);
      }
    }
    for (const m of Object.keys(STABLES)) if (S.tokens[m] && !S.prices[m]) S.prices[m] = { price: 1, symbol: STABLES[m], chg: {} };
    const sp = S.prices[SOL_MINT]?.price;
    if (sp) { S.solpx.push({ t: Date.now(), v: sp }); if (S.solpx.length > MAX_POINTS) S.solpx.splice(0, S.solpx.length - MAX_POINTS); save(LS_SOL, S.solpx); }
    setErr('DexScreener', null);
    log(`Prix DexScreener : SOL ${fmtUsd(sp)} · ${Object.keys(S.prices).length} token(s) pricé(s)`);
    ok(); render(); recordPoint();
  } catch (e) { setErr('DexScreener', e); }
}
function trackPeak(m, p) { if (!p) return; if (!S.peaks[m] || p > S.peaks[m]) { S.peaks[m] = p; save(LS_PEAK, S.peaks); } }

// ---------- state.json ----------
async function refreshState() {
  try {
    const st = await fetchJson(`data/state.json?t=${Date.now()}`, { cache: 'no-store' });
    const first = !S.state;
    S.state = st; S.stateLoadedAt = new Date();
    if (st.wallet) S.wallet = st.wallet;
    if (st.baseline?.usd) S.base = st.baseline;
    setErr('state.json', null);
    const top = (st.journal || [])[0];
    const key = top ? `${top.date}|${top.action}|${top.mint}` : null;
    if (!first && key && key !== S.seenTrade) scene.tradeEvent(top);
    S.seenTrade = key;
    log(`state.json généré ${ago(st.generated_at)} : ${(st.positions || []).length} position(s), ${(st.journal || []).length} trade(s)`);
    render(); scene.update();
    if (first) { refreshWallet(); refreshPrices(); }
  } catch (e) { setErr('state.json', e); }
}

// ---------- calculs ----------
function totals() {
  const sp = S.prices[SOL_MINT]?.price;
  if (S.sol == null || !sp) return null;
  let tok = 0, unpriced = 0;
  for (const [m, t] of Object.entries(S.tokens)) { const p = S.prices[m]?.price; if (p) tok += t.amount * p; else unpriced++; }
  const total = S.sol * sp + tok;
  return { total, solUsd: S.sol * sp, tok, unpriced, sp };
}
let lastRecord = 0;
function recordPoint() {
  const t = totals(); if (!t || Date.now() - lastRecord < 10000) return;
  lastRecord = Date.now();
  S.equity.push({ t: Date.now(), v: +t.total.toFixed(4) });
  if (S.equity.length > MAX_POINTS) S.equity.splice(0, S.equity.length - MAX_POINTS);
  save(LS_EQ, S.equity);
}
function posMetrics(p) {
  const r = S.state?.rules || {};
  const sl = (r.stop_loss_pct ?? -20) / 100, tp = r.take_profit_mult ?? 1.5, tr = (r.trailing_stop_pct ?? -20) / 100;
  const live = S.prices[p.mint]?.price ?? null;
  const entry = p.entry_price_usd;
  const peak = Math.max(p.peak_price_usd || 0, S.peaks[p.mint] || 0, live || 0) || null;
  const qty = S.tokens[p.mint]?.amount ?? p.amount_tokens ?? null;
  const value = live != null && qty != null ? live * qty : null;
  const cost = p.entry_usd != null ? p.entry_usd * (p.half_sold ? 0.5 : 1) : (entry && qty ? entry * qty : null);
  const pnlPct = live != null && entry ? (live / entry - 1) * 100 : null;
  const pnlUsd = value != null && cost != null ? value - cost : null;
  const stop = p.half_sold ? (peak ? peak * (1 + tr) : null) : (entry ? entry * (1 + sl) : null);
  const target = p.half_sold ? null : (entry ? entry * tp : null);
  const toStop = live && stop ? (stop / live - 1) * 100 : null;
  const toTarget = live && target ? (target / live - 1) * 100 : null;
  return { live, entry, peak, qty, value, cost, pnlPct, pnlUsd, stop, target, toStop, toTarget };
}

// ---------- rendu ----------
function render() {
  const st = S.state || {};
  const t = totals();
  $('walletLink').href = solscan(S.wallet); $('walletLink').textContent = short(S.wallet) + ' ↗';
  $('baseUsd').textContent = fmtUsd(S.base.usd); $('baseUsd2').textContent = fmtUsd(S.base.usd);
  const big = $('totalUsd');
  animate(big, t?.total, v => fmtUsd(v));
  const pnl = t ? t.total - S.base.usd : null;
  animate($('pnlUsd'), pnl, fmtSigned, false);
  const pp = pnl != null ? pnl / S.base.usd * 100 : null;
  $('pnlPct').textContent = fmtPct(pp);
  for (const el of [$('pnlUsd'), $('pnlPct')]) { el.classList.toggle('up', pnl > 0); el.classList.toggle('down', pnl < 0); }
  big.style.color = pnl == null ? '' : pnl >= 0 ? '#eafff5' : '#ffe9ed';
  animate($('solBal'), S.sol, v => fmtNum(v, 4));
  const sp = S.prices[SOL_MINT];
  animate($('solPx'), sp?.price, v => fmtUsd(v));
  $('solChg').innerHTML = sp ? ['m5', 'h1', 'h24'].map(k => { const c = sp.chg?.[k]; return c == null ? '' : `<span class="${c >= 0 ? 'up' : 'down'}">${k} ${fmtPct(c, 1)}</span>`; }).join(' ') : DASH;
  $('solPairInfo').textContent = sp ? `${sp.dex || ''} SOL/${sp.quote || ''} · ${S.solpx.length} pts` : DASH;
  const rules = st.rules || {};
  const npos = (st.positions || []).length;
  $('posCount').textContent = S.state ? `${npos} / ${rules.max_positions ?? 3}` : DASH;
  const s = st.stats || {};
  $('winRate').textContent = s.win_rate != null ? fmtPct(s.win_rate, 0).replace('+', '') : DASH;
  $('realized').textContent = s.realized_pnl_usd != null ? 'réalisé ' + fmtSigned(s.realized_pnl_usd) : (S.state ? `${s.closed ?? 0} trade(s) clôturé(s)` : DASH);
  $('stateAge').textContent = 'state.json : ' + (st.generated_at ? ago(st.generated_at) : DASH);
  $('ptsCount').textContent = `${S.equity.length} pts`;
  renderPositions(); renderHoldings(); renderScan(); renderSignals(); renderJournal(); renderRules(); renderAgentsList(); scene.slots();
}

function renderPositions() {
  const st = S.state; const el = $('posList');
  const r = st?.rules || {};
  $('posRule').textContent = st ? `SL ${r.stop_loss_pct}% · x${String(r.take_profit_mult).replace('.', ',')} → ½ · trailing ${r.trailing_stop_pct}%` : DASH;
  if (!st) { el.innerHTML = `<div class="empty">${DASH}</div>`; return; }
  if (!st.positions?.length) { el.innerHTML = `<div class="empty">Aucune position ouverte. Groky attend un signal qui passe tous les filtres.</div>`; return; }
  el.innerHTML = st.positions.map(p => {
    const m = posMetrics(p); const sym = p.symbol || S.prices[p.mint]?.symbol || short(p.mint);
    const lo = m.stop, hi = m.target ?? (m.peak ? m.peak * 1.1 : null);
    const pos = lo && hi && m.live ? Math.max(0, Math.min(100, (m.live - lo) / (hi - lo) * 100)) : null;
    const en = lo && hi && m.entry ? Math.max(0, Math.min(100, (m.entry - lo) / (hi - lo) * 100)) : null;
    const cls = m.pnlPct > 0 ? 'up' : m.pnlPct < 0 ? 'down' : '';
    return `<div class="pos">
      <div class="pos-h"><div><a class="sym" href="${esc(S.prices[p.mint]?.url || dexs(p.mint))}" target="_blank" rel="noopener">${esc(sym)} ↗</a>
        <div class="muted small">${esc(p.signal || DASH)} · ouvert ${dt(p.opened_at)}${p.half_sold ? ' · ½ vendue, trailing actif' : ''}</div></div>
        <div style="text-align:right"><div class="pp ${cls}">${fmtPct(m.pnlPct, 1)}</div><div class="muted small">${fmtSigned(m.pnlUsd)}</div></div></div>
      <div class="bar">${en != null ? `<div class="en" style="left:${en}%"></div>` : ''}${pos != null ? `<div class="mk" style="left:${pos}%"></div>` : ''}</div>
      <div class="bar-l"><span>${p.half_sold ? 'trailing' : 'stop'} ${fmtPrice(m.stop)}</span><span>entrée ${fmtPrice(m.entry)}</span><span>${m.target ? 'x1,5 ' + fmtPrice(m.target) : 'pic ' + fmtPrice(m.peak)}</span></div>
      <div class="pos-g">
        <div><span>Prix live</span>${fmtPrice(m.live)}</div>
        <div><span>Au stop</span><span class="down" style="font-family:var(--mono);font-size:12px;text-transform:none">${fmtPct(m.toStop, 1)}</span></div>
        <div><span>Au x1,5</span><span class="up" style="font-family:var(--mono);font-size:12px;text-transform:none">${m.target ? fmtPct(m.toTarget, 1) : (p.half_sold ? 'atteint' : DASH)}</span></div>
        <div><span>Valeur</span>${fmtUsd(m.value)}</div>
        <div><span>Mise</span>${fmtUsd(p.entry_usd)}</div>
        <div><span>Quantité</span>${fmtNum(m.qty, 2)}</div>
      </div></div>`;
  }).join('');
}

function renderHoldings() {
  const el = $('holdList');
  const rows = [];
  const sp = S.prices[SOL_MINT];
  if (S.sol != null) rows.push({ sym: 'SOL', sub: 'natif', amt: S.sol, usd: sp ? S.sol * sp.price : null, url: solscan(S.wallet) });
  for (const [m, t] of Object.entries(S.tokens)) {
    const p = S.prices[m];
    rows.push({ sym: p?.symbol || short(m), sub: short(m), amt: t.amount, usd: p ? t.amount * p.price : null, url: p?.url || dexs(m), chg: p?.chg?.h1 });
  }
  if (!rows.length) { el.innerHTML = `<div class="empty">${DASH}</div>`; return; }
  el.innerHTML = rows.map(r => `<div class="row"><div class="l"><b><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.sym)} ↗</a></b><small>${esc(r.sub)}</small></div>
    <div class="rr">${fmtUsd(r.usd)}<br><small class="muted">${fmtNum(r.amt, 4)}${r.chg != null ? ` · <span class="${r.chg >= 0 ? 'up' : 'down'}">1h ${fmtPct(r.chg, 1)}</span>` : ''}</small></div></div>`).join('');
}

function renderScan() {
  const sc = S.state?.last_scan; const el = $('scanBox');
  $('scanAt').textContent = sc?.at ? `${dt(sc.at)} · ${ago(sc.at)}` : DASH;
  if (!sc) { el.innerHTML = `<div class="empty">${DASH}<br><span class="small">Aucun scan publié dans state.json pour l'instant.</span></div>`; return; }
  const rej = Object.entries(sc.rejections || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rej.map(r => r[1]));
  el.innerHTML = `<div class="scan-k">
      <div class="kpi"><div class="label">Tokens vus</div><div class="v">${sc.tokens_scanned ?? DASH}</div></div>
      <div class="kpi"><div class="label">Retenus</div><div class="v">${sc.passed ?? DASH}</div></div>
      <div class="kpi"><div class="label">Rejetés</div><div class="v">${rej.length ? rej.reduce((s, r) => s + r[1], 0) : DASH}</div></div></div>
    ${rej.length ? `<div class="label" style="margin-bottom:6px">Raisons de rejet</div><div class="rej">${rej.map(([k, v]) => `<span>${esc(k)}</span><b>${v}</b><div class="b"><i style="width:${v / max * 100}%"></i></div>`).join('')}</div>` : ''}
    ${(sc.candidates || []).length ? `<div class="label" style="margin:8px 0 4px">Candidats</div>${sc.candidates.map(c => `<div class="row"><div class="l"><b>${esc(c.symbol || c.sym || short(c.mint))}</b></div><div class="rr">${c.mint ? `<a href="${dexs(c.mint)}" target="_blank" rel="noopener">DexScreener ↗</a>` : ''}</div></div>`).join('')}` : ''}
    ${sc.note ? `<div class="muted small" style="margin-top:6px">${esc(sc.note)}</div>` : ''}`;
}

function renderSignals() {
  const el = $('sigList'); const sigs = S.state?.signals;
  if (!sigs) { el.innerHTML = `<div class="empty">${DASH}</div>`; return; }
  if (!sigs.length) { el.innerHTML = `<div class="empty">Aucun signal pour l'instant.</div>`; return; }
  el.innerHTML = sigs.slice(0, 15).map(s => {
    const v = s.verdict ? `<span class="tag ${/ok|valid|go/i.test(s.verdict) ? 'ok' : 'ko'}">${esc(s.verdict)}</span>` : '';
    return `<div class="row"><div class="l"><b><span class="tag sig">${esc(s.type || DASH)}</span>${s.mint ? `<a href="${dexs(s.mint)}" target="_blank" rel="noopener">${esc(s.symbol || short(s.mint))} ↗</a>` : esc(s.symbol || DASH)}</b>
      <small>${esc(s.from)}${s.to ? ' → ' + esc(s.to) : ''}${s.wallet ? ' · ' + esc(s.wallet) : ''}${s.detail ? ' · ' + esc(s.detail) : ''}</small></div>
      <div class="rr">${v}<br><small class="muted">${dt(s.at)}</small></div></div>`;
  }).join('');
}

function renderJournal() {
  const el = $('journalList'); const j = S.state?.journal;
  $('tradeCount').textContent = j ? `${j.length} opération(s)` : DASH;
  if (!j) { el.innerHTML = `<div class="empty">${DASH}</div>`; return; }
  if (!j.length) { el.innerHTML = `<div class="empty">Aucun trade enregistré pour l'instant.</div>`; return; }
  el.innerHTML = j.slice(0, 40).map(r => {
    const buy = /buy|achat/i.test(r.action || '');
    return `<div class="row"><div class="l"><b><span class="tag ${buy ? 'buy' : 'sell'}">${esc((r.action || DASH).toUpperCase())}</span>${r.mint ? `<a href="${dexs(r.mint)}" target="_blank" rel="noopener">${esc(r.token || short(r.mint))} ↗</a>` : esc(r.token || DASH)}</b>
      <small>${dt(r.date)}${r.reason ? ' · ' + esc(r.reason) : ''}${r.signature ? ` · <a href="https://solscan.io/tx/${esc(r.signature)}" target="_blank" rel="noopener">tx ↗</a>` : ''}</small></div>
      <div class="rr">${fmtUsd(r.value_usd)}<br><small class="muted">${r.amount_sol != null ? fmtNum(r.amount_sol, 4) + ' SOL' : DASH} · ${fmtPrice(r.price_usd)}</small></div></div>`;
  }).join('');
}

function renderRules() {
  const r = S.state?.rules; const el = $('rules');
  if (!r) { el.innerHTML = `<div>${DASH}</div>`; return; }
  const f = r.filters || {};
  const k = (l, v) => `<div>${l}<b>${v}</b></div>`;
  el.innerHTML = [
    k('Taille / position', `≈ ${r.position_usd} $`), k('Positions max', r.max_positions), k('Réserve SOL', `${fmtNum(r.reserve_sol, 3)} SOL`),
    k('Stop-loss', `${r.stop_loss_pct} %`), k('Prise de profit', `x${String(r.take_profit_mult).replace('.', ',')} → vend ${r.take_profit_sell_pct} %`), k('Trailing stop', `${r.trailing_stop_pct} % du plus haut`),
    k('Slippage max', `${r.max_slippage_pct} %`), k('Liquidité min', fmtUsd(f.min_liquidity_usd, 0)), k('Âge min', `${f.min_age_h} h`),
    k('Volume 1 h min', fmtUsd(f.min_volume_1h_usd, 0)), k('Hausse 1 h max', `+${f.max_change_1h_pct} %`), k('Détenteur max', `${f.max_holder_pct} % de l'offre`),
    k('Mint &amp; freeze', f.mint_freeze_revoked ? 'révoqués' : DASH), k('Scan', `toutes les ${r.scan_every_min} min`),
  ].join('');
  const tw = S.state?.tracked_wallets || [];
  $('tracked').innerHTML = tw.length ? tw.map(w => `<div class="row"><div class="l"><b>${esc(w.name)}</b><small>${short(w.address)}</small></div><div class="rr"><a href="${solscan(w.address)}" target="_blank" rel="noopener">Solscan ↗</a></div></div>`).join('') : `<div class="empty">${DASH}</div>`;
}

// ---------- agents ----------
const ICONS = {
  groky: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
  radar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 12l6-6"/></svg>',
  garde: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke-linecap="round"/></svg>',
  stratege: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
};
const AG = ['groky', 'radar', 'garde', 'stratege'];
const COLORS = { groky: 'var(--groky)', radar: 'var(--radar)', garde: 'var(--garde)', stratege: 'var(--strat)' };
const HOME = { groky: [55, 66], radar: [20, 44], garde: [80, 44], stratege: [26, 87] };
const PATROL = { // points visités (en % de la scène) selon l'activité
  radar: [[20, 44], [28, 48], [14, 50], [24, 40]],
  garde: [[80, 44], [72, 48], [86, 50], [76, 40]],
  stratege: [[26, 87], [34, 84], [20, 90], [30, 82]],
  groky: [[55, 66], [64, 72], [48, 70], [60, 62]],
};
const statusCls = s => s === 'actif' ? 'active' : s === 'en veille' ? 'idle' : 'unknown';

const scene = (() => {
  const layer = () => $('agentLayer'), sc = () => $('scene');
  const els = {}, pos = {}, busyUntil = {}, step = {};
  function size() { const r = sc().getBoundingClientRect(); return [r.width, r.height]; }
  function place(k, x, y) {
    const [w, h] = size(); pos[k] = [x, y];
    const el = els[k]; if (!el) return;
    el.style.transform = `translate(${x / 100 * w}px, ${y / 100 * h}px)`;
    el.classList.toggle('bl', x < 28); el.classList.toggle('br', x > 72);
    el.classList.add('walk'); clearTimeout(el._w); el._w = setTimeout(() => el.classList.remove('walk'), 2600);
  }
  function ensure() {
    for (const k of AG) {
      if (els[k]) continue;
      const el = document.createElement('div'); el.className = 'agent unknown'; el.style.setProperty('--c', COLORS[k]);
      el.innerHTML = `<div class="bubble"></div><div class="body">${ICONS[k]}</div><div class="nm"></div><div class="zz">z z</div>`;
      layer().appendChild(el); els[k] = el; step[k] = 0;
      const [x, y] = HOME[k]; const [w, h] = size(); el.style.transition = 'none';
      el.style.transform = `translate(${x / 100 * w}px, ${y / 100 * h}px)`; pos[k] = [x, y];
      el.classList.toggle('bl', x < 28); el.classList.toggle('br', x > 72);
      requestAnimationFrame(() => requestAnimationFrame(() => el.style.transition = ''));
    }
  }
  function update() {
    ensure();
    const ag = S.state?.agents || {};
    for (const k of AG) {
      const a = ag[k] || {}, el = els[k];
      ['active', 'idle', 'unknown'].forEach(c => el.classList.remove(c)); el.classList.add(statusCls(a.status));
      el.querySelector('.nm').textContent = a.name || k;
      const txt = a.last_action || DASH;
      el.querySelector('.bubble').innerHTML = `${esc(txt.length > 46 ? txt.slice(0, 44) + '…' : txt)}<small>${a.at ? ago(a.at) : DASH}</small>`;
    }
    sc().classList.toggle('radar-on', (ag.radar?.status) === 'actif');
  }
  function recent(iso, min) { return iso && (Date.now() - new Date(iso)) / 60000 <= min; }
  function tick() {
    if (!S.state || document.hidden) return;
    ensure();
    const ag = S.state.agents || {}, now = Date.now();
    for (const k of AG) {
      if (busyUntil[k] > now) continue;
      const a = ag[k] || {};
      if (a.status !== 'actif') { const [x, y] = HOME[k]; if (pos[k][0] !== x || pos[k][1] !== y) place(k, x, y); continue; }
      const pts = PATROL[k]; step[k] = (step[k] + 1) % pts.length; place(k, ...pts[step[k]]);
    }
    // Radar porte son dernier signal récent (< 60 min) à Garde
    const sig = (S.state.signals || []).find(s => s.from === 'Radar');
    if (sig && recent(sig.at, 60) && !(busyUntil.radar > now) && Math.random() < 0.25) courier(sig);
  }
  function courier(sig) {
    const now = Date.now(); busyUntil.radar = now + 7000; busyUntil.garde = now + 9000;
    place('radar', 66, 46); setTimeout(() => { els.garde?.classList.add('ping'); place('garde', 76, 44); }, 2400);
    setTimeout(() => { els.garde?.classList.remove('ping'); place('radar', ...HOME.radar); }, 5200);
  }
  function tradeEvent(tr) {
    ensure();
    const now = Date.now(); busyUntil.groky = now + 9000;
    const idx = Math.max(0, (S.state?.positions || []).findIndex(p => p.mint === tr.mint));
    const slotX = [50 - 14, 50, 50 + 14][Math.min(2, idx)] ?? 50;
    els.groky.classList.add('ping'); place('groky', slotX, 30);
    log(`Nouveau trade : ${tr.action || ''} ${tr.token || ''}`);
    setTimeout(() => { els.groky.classList.remove('ping'); place('groky', ...HOME.groky); }, 6000);
  }
  function slots() {
    const el = $('slots'); if (!el) return;
    const st = S.state; const max = st?.rules?.max_positions ?? 3; const ps = st?.positions || [];
    let h = '';
    for (let i = 0; i < max; i++) {
      const p = ps[i];
      if (p) { const m = posMetrics(p); h += `<div class="slot full"><b>${esc(p.symbol || S.prices[p.mint]?.symbol || short(p.mint))}</b><span class="p ${m.pnlPct >= 0 ? 'up' : 'down'}">${fmtPct(m.pnlPct, 1)}</span></div>`; }
      else h += `<div class="slot">libre</div>`;
    }
    el.innerHTML = h;
  }
  addEventListener('resize', () => { for (const k of AG) if (pos[k]) { const el = els[k]; el.style.transition = 'none'; place(k, ...pos[k]); requestAnimationFrame(() => el.style.transition = ''); } });
  return { update, tick, tradeEvent, slots };
})();

function renderAgentsList() {
  const ag = S.state?.agents; const el = $('agentList');
  el.innerHTML = AG.map(k => {
    const a = ag?.[k] || {};
    const st = a.status || null;
    return `<div class="ag" style="--c:${COLORS[k]}"><div class="av">${ICONS[k]}</div><div>
      <div class="t">${esc(a.name || ({ groky: 'Groky', radar: 'Radar', garde: 'Garde', stratege: 'Stratège' })[k])} <span class="st ${st === 'actif' ? 'actif' : st === 'en veille' ? 'veille' : ''}">${esc(st || DASH)}</span></div>
      <div class="r">${esc(a.role || DASH)}</div>
      <div class="a">${esc(a.last_action || DASH)} <span class="muted small">· ${a.at ? dt(a.at) : DASH}</span></div>
      ${a.detail ? `<div class="r">${esc(a.detail)}</div>` : ''}</div></div>`;
  }).join('');
}

// ---------- graphiques (canvas, défilement continu) ----------
function setupCanvas(c) {
  const dpr = Math.min(3, devicePixelRatio || 1), r = c.getBoundingClientRect();
  if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return [ctx, r.width, r.height];
}
let hover = null;
function drawSeries(canvas, pts, { range, base, color, fmt, grid = true, tipEl }) {
  const [ctx, W, H] = setupCanvas(canvas); ctx.clearRect(0, 0, W, H);
  const now = Date.now(); const padL = 4, padR = 58, padT = 10, padB = 18;
  let data = pts; const t0 = range ? now - range : (pts[0]?.t ?? now - 60000);
  data = pts.filter(p => p.t >= t0 - 60000);
  ctx.font = '10px ui-monospace,Menlo,monospace'; ctx.fillStyle = '#5d6a7c';
  if (data.length < 2) { ctx.textAlign = 'center'; ctx.fillText(data.length ? 'Collecte des points en direct…' : '—', W / 2, H / 2); return; }
  const last = data[data.length - 1]; const series = [...data, { t: now, v: last.v }];
  let lo = Math.min(...series.map(p => p.v)), hi = Math.max(...series.map(p => p.v));
  if (base != null && range !== 0) { lo = Math.min(lo, base); hi = Math.max(hi, base); }
  const span = hi - lo || Math.max(Math.abs(hi) * 0.002, 0.01); lo -= span * 0.12; hi += span * 0.12;
  const X = t => padL + (t - t0) / (now - t0) * (W - padL - padR), Y = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  if (grid) {
    ctx.strokeStyle = 'rgba(125,138,156,.12)'; ctx.lineWidth = 1; ctx.textAlign = 'left';
    for (let i = 0; i <= 3; i++) { const v = lo + (hi - lo) * (i / 3), y = Y(v); ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke(); ctx.fillText(fmt(v), W - padR + 6, y + 3); }
    ctx.textAlign = 'center';
    for (let i = 0; i <= 3; i++) { const t = t0 + (now - t0) * (i / 3); ctx.fillText(parisFmt.format(t).slice(0, 5), Math.min(W - padR - 14, Math.max(padL + 14, X(t))), H - 4); }
  }
  if (base != null) { const y = Y(base); if (y > padT && y < H - padB) { ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(125,138,156,.6)'; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke(); ctx.setLineDash([]); } }
  const up = base == null ? last.v >= data[0].v : last.v >= base;
  const col = color || (up ? '#22e39a' : '#ff4d6a');
  ctx.beginPath(); series.forEach((p, i) => { const x = Math.max(padL, X(p.t)), y = Y(p.v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.lineTo(X(now), H - padB); ctx.lineTo(Math.max(padL, X(series[0].t)), H - padB); ctx.closePath();
  const g = ctx.createLinearGradient(0, padT, 0, H - padB); g.addColorStop(0, col + '44'); g.addColorStop(1, col + '00'); ctx.fillStyle = g; ctx.fill();
  const lx = X(now), ly = Y(last.v), pulse = (Math.sin(now / 300) + 1) / 2;
  ctx.beginPath(); ctx.arc(lx, ly, 3 + pulse * 5, 0, 7); ctx.fillStyle = col + '33'; ctx.fill();
  ctx.beginPath(); ctx.arc(lx, ly, 3, 0, 7); ctx.fillStyle = col; ctx.fill();
  ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.font = 'bold 10px ui-monospace,Menlo,monospace';
  ctx.fillRect(W - padR + 2, ly - 8, padR - 2, 16); ctx.fillStyle = '#04110b'; ctx.fillText(fmt(last.v), W - padR + 5, ly + 3);
  if (tipEl) {
    if (hover && hover.canvas === canvas) {
      const t = t0 + (hover.x - padL) / (W - padL - padR) * (now - t0);
      let best = data[0]; for (const p of data) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      const x = X(best.t), y = Y(best.v);
      ctx.strokeStyle = 'rgba(230,237,246,.3)'; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
      tipEl.hidden = false; tipEl.textContent = `${hhmmss(best.t)} · ${fmt(best.v)}${base ? ' · ' + fmtPct((best.v / base - 1) * 100) : ''}`;
    } else tipEl.hidden = true;
  }
}
function loop() {
  if (!document.hidden) {
    drawSeries($('equityChart'), S.equity, { range: S.range, base: S.base.usd, fmt: v => '$' + v.toFixed(2), tipEl: $('equityTip') });
    drawSeries($('solChart'), S.solpx, { range: S.range || 0, base: null, color: '#4da3ff', fmt: v => '$' + v.toFixed(2) });
  }
  setTimeout(() => requestAnimationFrame(loop), 50);
}
function bindChart() {
  const c = $('equityChart');
  const mv = e => { const r = c.getBoundingClientRect(); const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left; hover = { canvas: c, x }; };
  c.addEventListener('mousemove', mv); c.addEventListener('touchstart', mv, { passive: true }); c.addEventListener('touchmove', mv, { passive: true });
  const out = () => hover = null; c.addEventListener('mouseleave', out); c.addEventListener('touchend', () => setTimeout(out, 1500));
  document.querySelectorAll('#rangeSeg button').forEach(b => {
    b.classList.toggle('on', +b.dataset.r === S.range);
    b.onclick = () => { S.range = +b.dataset.r; localStorage.setItem(LS_RANGE, S.range); document.querySelectorAll('#rangeSeg button').forEach(x => x.classList.toggle('on', x === b)); };
  });
}

// ---------- démarrage ----------
function every(fn, ms) { setInterval(() => { if (!document.hidden) fn(); }, ms); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshState(); refreshWallet(); refreshPrices(); } });
addEventListener('online', () => { refreshWallet(); refreshPrices(); });
bindChart(); render(); scene.update();
refreshState().then(() => { if (!S.state) { refreshWallet(); refreshPrices(); } });
every(refreshWallet, T_WALLET); every(refreshPrices, T_PRICES); every(refreshState, T_STATE);
setInterval(scene.tick, T_SCENE); setTimeout(scene.tick, 800);
setInterval(() => { renderLive(); if (S.state) { $('stateAge').textContent = 'state.json : ' + ago(S.state.generated_at); scene.update(); } }, 15000);
loop();
})();
