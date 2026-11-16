/* brokeboy : wallet + agents en direct. Lecture seule, aucune clé API, aucune donnée inventée. */
(() => {
'use strict';
const DEFAULT_WALLET = '4sPACuXcJ3ssYURkuyxHDUsDh39WpEdreDxus2B969rB';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const STABLES = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC', Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT' };
const qs = new URLSearchParams(location.search);
const RPCS = [qs.get('rpc'), 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
const T_WALLET = 15000, T_PRICES = 20000, T_STATE = 45000, MAX_POINTS = 6000;
const LS_EQ = 'groky.equity.v1', LS_SOL = 'groky.solpx.v1', LS_PEAK = 'groky.peaks.v1', LS_SCAN = 'groky.scans.v1';
const DASH = '—';

const S = {
  wallet: DEFAULT_WALLET, base: { sol: 1.527, usd: 109.5 }, state: null,
  sol: null, tokens: {}, prices: {}, rpcIdx: 0, indexedBroken: {}, errors: {}, lastOk: null,
  equity: load(LS_EQ, []), solpx: load(LS_SOL, []), peaks: load(LS_PEAK, {}), scans: load(LS_SCAN, []),
  seenTrade: undefined, prevSol: null,
};

// ---------- utilitaires ----------
function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ok_ = v => v != null && isFinite(v);
const nf = (v, d) => v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUsd = (v, d = 2) => ok_(v) ? nf(v, d) + '\u00a0$' : DASH;
const fmtSol = (v, d = 4) => ok_(v) ? nf(v, d) + '\u00a0SOL' : DASH;
const fmtSignedUsd = v => ok_(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + fmtUsd(Math.abs(v)) : DASH;
const fmtSignedSol = (v, d = 4) => ok_(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + fmtSol(Math.abs(v), d) : DASH;
const fmtPct = (v, d = 1) => ok_(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + nf(Math.abs(v), d) + '\u00a0%' : DASH;
const fmtAmt = v => !ok_(v) ? DASH : v >= 1e6 ? nf(v / 1e6, 2) + ' M' : v >= 1e3 ? nf(v / 1e3, 2) + ' k' : nf(v, v >= 1 ? 2 : 4);
function fmtPrice(p) { if (!ok_(p)) return DASH; if (p >= 1) return fmtUsd(p, p >= 100 ? 2 : 4); const d = Math.min(10, Math.max(4, 4 - Math.floor(Math.log10(p)))); return p.toFixed(d).replace('.', ',') + '\u00a0$'; }
const parisT = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const parisHM = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
const parisDM = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const hm = iso => { if (!iso) return DASH; const d = new Date(iso); return isNaN(d) ? DASH : parisHM.format(d); };
const dm = iso => { if (!iso) return DASH; const d = new Date(iso); return isNaN(d) ? DASH : parisDM.format(d); };
function agoShort(t) { if (!t) return DASH; const s = (Date.now() - new Date(t)) / 1000; if (!isFinite(s)) return DASH; if (s < 10) return 'just now'; if (s < 60) return `${Math.round(s)}s ago`; if (s < 3600) return `${Math.round(s / 60)} min ago`; return `${Math.floor(s / 3600)} h ago`; }
const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : DASH;
const dexs = m => `https://dexscreener.com/solana/${m}`;
const minsAgo = iso => iso ? (Date.now() - new Date(iso)) / 60000 : Infinity;

// ---------- réseau ----------
async function fetchJson(url, opts = {}, timeout = 10000) {
  const ctl = new AbortController(); const id = setTimeout(() => ctl.abort(), timeout);
  try { const r = await fetch(url, { ...opts, signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  catch (e) { if (e.name === 'AbortError') throw new Error('délai dépassé'); throw e; }
  finally { clearTimeout(id); }
}
async function rpcCall(method, params, { indexed = false } = {}) {
  let lastErr;
  for (let i = 0; i < RPCS.length; i++) {
    const idx = (S.rpcIdx + i) % RPCS.length, url = RPCS[idx];
    if (indexed && S.indexedBroken[url] > Date.now()) continue;
    try {
      const j = await fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (j.error) throw new Error(j.error.message || 'erreur RPC');
      if (!indexed) S.rpcIdx = idx;
      return { result: j.result, url };
    } catch (e) { lastErr = e; if (indexed) S.indexedBroken[url] = Date.now() + 600000; }
  }
  throw lastErr || new Error('aucun RPC');
}
function setErr(src, e) { if (e) S.errors[src] = String(e.message || e).slice(0, 80); else delete S.errors[src]; renderLive(); }
const markOk = () => { S.lastOk = new Date(); renderLive(); };

// ---------- wallet ----------
async function refreshWallet() {
  try {
    const { result } = await rpcCall('getBalance', [S.wallet]);
    const sol = result.value / 1e9;
    const tokens = {}; let got = false;
    try {
      for (const prog of TOKEN_PROGRAMS) {
        const r = await rpcCall('getTokenAccountsByOwner', [S.wallet, { programId: prog }, { encoding: 'jsonParsed' }], { indexed: true });
        for (const a of r.result.value) addTok(tokens, a.account.data.parsed.info);
      }
      got = true;
    } catch {}
    const known = (S.state?.token_accounts || []).map(a => a.account);
    if (!got && known.length) {
      const r = await rpcCall('getMultipleAccounts', [known.slice(0, 100), { encoding: 'jsonParsed' }]);
      for (const a of r.result.value) if (a?.data?.parsed?.info) addTok(tokens, a.data.parsed.info);
      got = true;
    }
    if (got) S.tokens = tokens;
    if (S.prevSol != null && Math.abs(sol - S.prevSol) >= 1e-6) balanceToast(S.prevSol, sol);
    S.prevSol = sol; S.sol = sol;
    setErr('RPC', null); markOk(); render(); recordPoint();
  } catch (e) { setErr('RPC', e); }
}
function addTok(map, info) { const amt = +info.tokenAmount.uiAmountString; if (!amt) return; map[info.mint] = { amount: (map[info.mint]?.amount || 0) + amt }; }

// ---------- prix ----------
async function refreshPrices() {
  const mints = new Set([SOL_MINT]);
  Object.keys(S.tokens).forEach(m => mints.add(m));
  (S.state?.positions || []).forEach(p => p.mint && mints.add(p.mint));
  (S.state?.journal || []).slice(0, 25).forEach(r => r.mint && mints.add(r.mint));
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
        const prev = S.prices[m];
        S.prices[m] = { price: +p.priceUsd, symbol: p.baseToken.symbol, name: p.baseToken.name, url: p.url, chg: p.priceChange || {}, img: p.info?.imageUrl || prev?.img };
        if (+p.priceUsd && (!S.peaks[m] || +p.priceUsd > S.peaks[m])) { S.peaks[m] = +p.priceUsd; save(LS_PEAK, S.peaks); }
      }
    }
    for (const m of Object.keys(STABLES)) if (S.tokens[m] && !S.prices[m]) S.prices[m] = { price: 1, symbol: STABLES[m], chg: {} };
    const sp = S.prices[SOL_MINT]?.price;
    if (sp) { S.solpx.push({ t: Date.now(), v: sp }); if (S.solpx.length > MAX_POINTS) S.solpx.splice(0, S.solpx.length - MAX_POINTS); save(LS_SOL, S.solpx); }
    setErr('DexScreener', null); markOk(); render(); recordPoint();
  } catch (e) { setErr('DexScreener', e); }
}

// ---------- state.json ----------
async function refreshState() {
  try {
    const st = await fetchJson(`data/state.json?t=${Date.now()}`, { cache: 'no-store' });
    const first = !S.state;
    S.state = st;
    if (st.wallet) S.wallet = st.wallet;
    if (st.baseline?.usd) S.base = st.baseline;
    const ls = st.last_scan;
    if (ls?.at && !S.scans.some(s => s.at === ls.at)) {
      const rej = Object.values(ls.rejections || {}).reduce((a, b) => a + b, 0);
      S.scans.push({ at: ls.at, t: +new Date(ls.at), scanned: ls.tokens_scanned, passed: ls.passed, rejected: rej });
      S.scans.sort((a, b) => a.t - b.t); if (S.scans.length > 500) S.scans.splice(0, S.scans.length - 500); save(LS_SCAN, S.scans);
    }
    const top = (st.journal || [])[0];
    const key = top ? `${top.date}|${top.action}|${top.mint}|${top.signature}` : null;
    if (S.seenTrade !== undefined && key && key !== S.seenTrade) tradeToast(top);
    S.seenTrade = key;
    setErr('state.json', null); render();
    if (first) { refreshWallet(); refreshPrices(); }
  } catch (e) { setErr('state.json', e); }
}

// ---------- calculs ----------
function totals() {
  const sp = S.prices[SOL_MINT]?.price; if (S.sol == null || !sp) return null;
  let tok = 0; for (const [m, t] of Object.entries(S.tokens)) { const p = S.prices[m]?.price; if (p) tok += t.amount * p; }
  return { total: S.sol * sp + tok, sp, totalSol: S.sol + tok / sp };
}
let lastRec = 0;
function recordPoint() {
  const t = totals(); if (!t || Date.now() - lastRec < 10000) return; lastRec = Date.now();
  S.equity.push({ t: Date.now(), v: +t.total.toFixed(4) });
  if (S.equity.length > MAX_POINTS) S.equity.splice(0, S.equity.length - MAX_POINTS); save(LS_EQ, S.equity);
}
function closedTrades() { // regroupe le journal par mint, uniquement des chiffres réels
  const st = S.state; if (!st) return null;
  const open = new Set((st.positions || []).map(p => p.mint));
  const per = {};
  for (const r of [...(st.journal || [])].reverse()) {
    if (!r.mint) continue; const a = (r.action || '').toLowerCase();
    const d = per[r.mint] ||= { mint: r.mint, token: r.token, buy: 0, sell: 0, sells: 0, reason: null, at: null, known: true };
    if (/buy|achat/.test(a)) { if (r.value_usd == null) d.known = false; else d.buy += r.value_usd; d.reason ||= r.reason; }
    else if (/sell|vente|stop|tp|trailing/.test(a)) { if (r.value_usd == null) d.known = false; else d.sell += r.value_usd; d.sells++; d.at = r.date; }
  }
  return Object.values(per).filter(d => d.sells > 0 && !open.has(d.mint)).map(d => ({ ...d, pnl: d.known && d.buy > 0 ? d.sell - d.buy : null, pct: d.known && d.buy > 0 ? (d.sell / d.buy - 1) * 100 : null })).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}
function posMetrics(p) {
  const r = S.state?.rules || {}; const live = S.prices[p.mint]?.price ?? null; const entry = p.entry_price_usd;
  const peak = Math.max(p.peak_price_usd || 0, S.peaks[p.mint] || 0, live || 0) || null;
  const qty = S.tokens[p.mint]?.amount ?? p.amount_tokens ?? null;
  const value = ok_(live) && ok_(qty) ? live * qty : null;
  const cost = p.entry_usd != null ? p.entry_usd * (p.half_sold ? .5 : 1) : null;
  const stop = p.half_sold ? (peak ? peak * (1 + (r.trailing_stop_pct ?? -20) / 100) : null) : (entry ? entry * (1 + (r.stop_loss_pct ?? -20) / 100) : null);
  const target = p.half_sold ? null : (entry ? entry * (r.take_profit_mult ?? 1.5) : null);
  return { live, pnlPct: live && entry ? (live / entry - 1) * 100 : null, pnlUsd: value != null && cost != null ? value - cost : null, toStop: live && stop ? (stop / live - 1) * 100 : null, toTarget: live && target ? (target / live - 1) * 100 : null };
}

// ---------- rendu : solde à rouleaux ----------
function odometer(el, str) {
  const chars = [...str]; const sig = chars.map(c => /\d/.test(c) ? 'd' : c).join('');
  const fresh = el._sig !== sig;
  if (fresh) {
    el._sig = sig;
    el.innerHTML = chars.map(c => /\d/.test(c) ? `<span class="dg"><span>${[...'0123456789'].map(d => `<i>${d}</i>`).join('')}</span></span>` : `<span class="ch">${c === ' ' || c === '\u00a0' ? '&nbsp;' : esc(c)}</span>`).join('');
  }
  const cols = el.querySelectorAll('.dg>span'); let k = 0;
  const apply = () => { k = 0; chars.forEach(c => { if (/\d/.test(c)) cols[k++].style.transform = `translateY(${-(+c) * 1.08}em)`; }); };
  if (fresh) { void el.offsetWidth; }
  apply();
}

function renderLive() {
  const errs = Object.entries(S.errors);
  const d = $('ldot'); d.className = 'ldot ' + (S.lastOk ? (errs.length ? 'warn' : 'ok') : (errs.length ? 'err' : ''));
  $('liveTxt').textContent = S.lastOk ? `En direct · ${parisT.format(S.lastOk)}` : (errs.length ? 'Hors ligne' : 'Connexion…');
  $('errLine').innerHTML = errs.length ? `<span class="e">⚠ ${errs.map(([k, v]) => esc(`${k} : ${v}`)).join(' · ')} (nouvel essai auto)</span>` : '';
  $('updated').textContent = S.lastOk ? `Updated ${agoShort(S.lastOk)}` : DASH;
}

function render() {
  const t = totals(); const st = S.state;
  // carte wallet
  $('solscanBtn').href = `https://solscan.io/account/${S.wallet}`;
  $('addr').textContent = S.wallet; $('addrShort').textContent = '•••• ' + S.wallet.slice(-4);
  const bal = $('balance');
  if (t) odometer(bal, fmtUsd(t.total)); else { bal._sig = null; bal.textContent = DASH; }
  const pnl = t ? t.total - S.base.usd : null, pnlSol = t ? t.totalSol - S.base.sol : null;
  const pp = $('pnlPill');
  pp.className = 'pnl' + (pnl > 0 ? ' up' : pnl < 0 ? ' down' : '');
  pp.textContent = t ? `${fmtSignedUsd(pnl)} · ${fmtSignedSol(pnlSol)}` : DASH;
  pp.title = `Depuis la base : ${fmtSol(S.base.sol, 3)} ≈ ${fmtUsd(S.base.usd)}`;
  $('solLine').textContent = t ? `${fmtSol(S.sol)} · SOL ${fmtUsd(t.sp)} · base ${fmtSol(S.base.sol, 3)} ≈ ${fmtUsd(S.base.usd)} (${fmtPct(pnl / S.base.usd * 100, 2)})` : DASH;
  renderTokens(); renderAgents(); renderOpen(); renderClosed(); renderGoal(); renderLive();
}

function tokIcon(img, sym, sol) {
  if (sol) return `<span class="ic sol">◎</span>`;
  if (img) return `<img class="ic" src="${esc(img)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;ic&quot;>${esc((sym || '?')[0])}</span>'">`;
  return `<span class="ic">${esc((sym || '?')[0])}</span>`;
}
function renderTokens() {
  const el = $('tokens'); const rows = [];
  const sp = S.prices[SOL_MINT];
  if (S.sol != null) rows.push({ sol: true, name: 'Solana', amt: `${fmtAmt(S.sol)} SOL`, usd: sp ? S.sol * sp.price : null, chg: sp?.chg?.h24, url: `https://solscan.io/account/${S.wallet}` });
  for (const [m, tk] of Object.entries(S.tokens)) {
    const p = S.prices[m];
    rows.push({ img: p?.img, sym: p?.symbol, name: p?.name || p?.symbol || short(m), amt: `${fmtAmt(tk.amount)} ${p?.symbol || ''}`, usd: p ? tk.amount * p.price : null, chg: p?.chg?.h24, url: p?.url || dexs(m) });
  }
  if (!rows.length) { el.innerHTML = `<div class="empty">${DASH}</div>`; return; }
  el.innerHTML = rows.map(r => `<a class="tok" href="${esc(r.url)}" target="_blank" rel="noopener">${tokIcon(r.img, r.sym || r.name, r.sol)}
    <div class="tl"><div class="tn">${esc(r.name)}</div><div class="ta">${esc(r.amt)}</div></div>
    <div class="tr">${fmtUsd(r.usd)}<small class="${r.chg > 0 ? 'up' : r.chg < 0 ? 'down' : 'mut'}" title="variation 24 h">${ok_(r.chg) ? fmtPct(r.chg) : DASH}</small></div></a>`).join('');
}

// ---------- agents ----------
const ICON = {
  groky: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
  radar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 12l6-6"/></svg>',
  garde: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke-linecap="round"/></svg>',
  stratege: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 20V11M10 20V5M16 20v-6M22 20H2"/></svg>',
  sniper: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/></svg>',
};
const AG = [
  { k: 'groky', name: 'Groky', c: '#FF4500', sg: 'momentum · exécution' },
  { k: 'radar', name: 'Radar', c: '#8A2BE2', sg: 'veille X · DIP' },
  { k: 'garde', name: 'Garde', c: '#00CED1', sg: 'risque · sécurité' },
  { k: 'stratege', name: 'Stratège', c: '#32CD32', sg: 'performance' },
  { k: 'sniper', name: 'Sniper', c: '#FF2D95', sg: 'entrée retardée · PAPIER' },
];
const sparks = {}; // k -> {canvas, series, born}
function agentData(k) {
  const st = S.state || {}; const a = st.agents?.[k] || {}; const ls = st.last_scan; const t = totals();
  const stats = st.stats || {}; const sigs = st.signals || [];
  const rej = ls ? Object.values(ls.rejections || {}).reduce((x, y) => x + y, 0) : null;
  const status = a.status || null;
  const line = a.last_action ? `${a.at ? hm(a.at) + ' · ' : ''}${a.last_action}` : DASH;
  const six = Date.now() - 6 * 3600e3;
  const base = { status, line, at: a.at };
  if (k === 'groky') {
    const npos = (st.positions || []).length, max = st.rules?.max_positions ?? 3;
    return { ...base, chip: !S.state ? DASH : `${npos}/${max} pos · ${stats.closed ?? 0} closes`,
      pct: t ? (t.total / S.base.usd - 1) * 100 : null, pl: 'vs base',
      ring: S.state ? `${npos}/${max}` : DASH, frac: S.state ? npos / max : 0, rl: 'positions',
      series: S.equity.filter(p => p.t >= six).map(p => p.v) };
  }
  if (k === 'radar') {
    const n = sigs.filter(s => s.from === 'Radar').length;
    return { ...base, line: a.last_action ? `${a.at ? hm(a.at) + ' · ' : ''}${a.last_action}${a.detail ? ' · ' + a.detail : ''}` : DASH,
      chip: S.state ? `${n} signal${n > 1 ? 'x' : ''}` : DASH,
      pct: ls && ls.tokens_scanned ? (ls.passed || 0) / ls.tokens_scanned * 100 : null, pl: ls ? `retenus /${ls.tokens_scanned}` : 'retenus', pctNoSign: true,
      ring: S.state ? String(n) : DASH, frac: Math.min(1, n / 5), rl: 'signaux',
      series: S.solpx.filter(p => p.t >= six).map(p => p.v), sl: 'SOL' };
  }
  if (k === 'garde') {
    const v = sigs.filter(s => s.from === 'Garde');
    const ok = v.filter(s => /ok|valid|go/i.test(s.verdict || '')).length;
    return { ...base, chip: ls ? `${rej} rejets` : DASH,
      pct: ls && ls.tokens_scanned ? rej / ls.tokens_scanned * 100 : null, pl: 'filtrés', pctNoSign: true,
      ring: v.length ? `${ok}/${v.length}` : DASH, frac: v.length ? ok / v.length : 0, rl: 'validés',
      series: S.scans.slice(-60).map(s => s.rejected) };
  }
  if (k === 'sniper') {
    const sn = st.sniper; if (!sn) return { ...base, chip: DASH, pct: null, pl: 'réussite papier', pctNoSign: true, ring: DASH, frac: 0, rl: 'positions', series: [] };
    const ss = sn.stats || {}, sl = sn.last_scan || {}, maxp = 3, op = ss.open ?? 0;
    let c2 = 0; const ser2 = (sn.recent_closed || []).filter(d => d.pnl_usd != null).slice().reverse().map(d => (c2 += d.pnl_usd));
    const pnl = (ss.realized_pnl_usd ?? 0) + (ss.unrealized_pnl_usd ?? 0);
    return { ...base,
      chip: ss.closed || op ? `PnL papier ${fmtSignedUsd(pnl)}` : (sl.in_window != null ? `${sl.in_window} migrés · ${sl.passed || 0} retenu${(sl.passed || 0) > 1 ? 's' : ''}` : DASH),
      pct: ss.win_rate ?? null, pl: 'réussite papier', pctNoSign: true,
      ring: `${op}/${maxp}`, frac: op / maxp, rl: 'positions',
      series: ser2.length ? [0, ...ser2] : [] };
  }
  const ct = closedTrades() || [];
  let cum = 0; const ser = ct.filter(d => d.pnl != null).reverse().map(d => (cum += d.pnl));
  return { ...base, chip: stats.realized_pnl_usd != null ? `réalisé ${fmtSignedUsd(stats.realized_pnl_usd)}` : (S.state ? `${stats.closed ?? 0} closes` : DASH),
    pct: stats.win_rate ?? null, pl: 'réussite', pctNoSign: true,
    ring: stats.closed ? `${stats.wins}/${stats.closed}` : DASH, frac: stats.closed ? stats.wins / stats.closed : 0, rl: 'gagnants',
    series: ser.length ? [0, ...ser] : [] };
}
function renderAgents() {
  const wrap = $('agentList');
  if (!wrap.children.length) {
    wrap.innerHTML = AG.map(a => `<div class="ag" id="ag-${a.k}" style="--c:${a.c}">
      <div class="av">${ICON[a.k]}</div>
      <div class="mid"><div class="l1"><span class="nm">${a.name}</span><span class="sg">${a.sg}</span></div>
        <div class="status"></div><span class="chip"></span>
        <div class="spark"><canvas></canvas></div></div>
      <div class="right"><span class="tag"></span>
        <div class="rr"><div style="text-align:right"><div class="pct"></div><div class="pl"></div></div>
          <div><div class="ring"><svg viewBox="0 0 44 44"><circle class="bg" cx="22" cy="22" r="18"/><circle class="fg" cx="22" cy="22" r="18" stroke-dasharray="113.1" stroke-dashoffset="113.1"/></svg><span class="rv"></span></div><div class="rl"></div></div></div></div>
    </div>`).join('');
    for (const a of AG) sparks[a.k] = { canvas: wrap.querySelector(`#ag-${a.k} canvas`), series: [], born: performance.now(), color: a.c };
  }
  let active = 0;
  for (const a of AG) {
    const d = agentData(a.k); const el = $('ag-' + a.k);
    if (d.status === 'actif') active++;
    el.classList.toggle('active', d.status === 'actif');
    const s = el.querySelector('.status'); if (s.textContent !== d.line) { s.textContent = d.line; s.title = d.line; s.classList.remove('flash'); void s.offsetWidth; s.classList.add('flash'); }
    el.querySelector('.chip').textContent = d.chip;
    const tag = el.querySelector('.tag'); tag.textContent = d.status === 'actif' ? 'ACTIF' : d.status === 'en veille' ? 'VEILLE' : DASH; tag.classList.toggle('off', d.status !== 'actif');
    const pc = el.querySelector('.pct'); pc.textContent = d.pctNoSign ? (ok_(d.pct) ? nf(d.pct, d.pct > 0 && d.pct < 10 ? 1 : 0) + '\u00a0%' : DASH) : fmtPct(d.pct);
    pc.className = 'pct' + (!d.pctNoSign && d.pct > 0 ? ' up' : !d.pctNoSign && d.pct < 0 ? ' down' : '');
    el.querySelector('.pl').textContent = d.pl;
    el.querySelector('.rv').textContent = d.ring; el.querySelector('.rl').textContent = d.rl;
    el.querySelector('.fg').style.strokeDashoffset = 113.1 * (1 - Math.max(0, Math.min(1, d.frac || 0)));
    const sp = sparks[a.k]; if (sp.series.length < 2 && d.series.length >= 2) sp.born = performance.now(); sp.series = d.series;
  }
  const st = S.state;
  $('agentsSub').textContent = st ? `${AG.length} agents · ${active} actif${active > 1 ? 's' : ''}` : `${AG.length} agents · —`;
  const t = totals(); $('multPill').textContent = t ? nf(t.total / S.base.usd, 2) + '×' : DASH;
  const g = st?.agents?.groky; const on = g && minsAgo(g.at) <= 35;
  $('autoPill').classList.toggle('on', !!on); $('autoTxt').textContent = on ? 'ON' : DASH;
  $('autoPill').title = g?.at ? `Dernier passage de Groky : ${dm(g.at)}` : 'Aucune activité récente publiée';
}
function renderOpen() {
  const ps = S.state?.positions || []; $('openBox').hidden = !ps.length; $('openBadge').textContent = ps.length;
  $('openList').innerHTML = ps.map(p => { const m = posMetrics(p); const sym = p.symbol || S.prices[p.mint]?.symbol || short(p.mint);
    return `<div class="op-row"><a href="${esc(S.prices[p.mint]?.url || dexs(p.mint))}" target="_blank" rel="noopener"><b>$${esc(sym)}</b> <small>· ${esc(p.signal || DASH)}</small></a>
      <b class="${m.pnlPct > 0 ? 'up' : m.pnlPct < 0 ? 'down' : ''}">${fmtPct(m.pnlPct)}</b>
      <small>stop ${fmtPct(m.toStop)} · x1,5 ${p.half_sold ? 'atteint' : fmtPct(m.toTarget)}</small><small style="text-align:right">${fmtSignedUsd(m.pnlUsd)}</small></div>`; }).join('');
}
function renderClosed() {
  const ct = closedTrades(); const el = $('ticker');
  $('closedBadge').textContent = ct ? ct.length : DASH;
  const st = S.state?.stats; $('realizedTxt').textContent = st?.realized_pnl_usd != null ? `réalisé ${fmtSignedUsd(st.realized_pnl_usd)}` : '';
  if (!ct) { el.innerHTML = `<div class="waiting">${DASH}</div>`; el._k = null; return; }
  if (!ct.length) {
    const ls = S.state.last_scan;
    const k = 'empty' + (ls?.at || '');
    if (el._k !== k) { el._k = k; el.innerHTML = `<div class="waiting"><div><i></i>En attente du premier trade</div><small>${ls ? `Dernier scan ${hm(ls.at)} : ${ls.tokens_scanned} tokens, ${ls.passed || 0} retenu(s)` : ''}</small></div>`; }
    return;
  }
  const rows = ct.map(d => { const p = S.prices[d.mint]; const sym = d.token || p?.symbol || short(d.mint);
    return `<a class="tr-row" href="${esc(p?.url || dexs(d.mint))}" target="_blank" rel="noopener">${p?.img ? `<img class="ti" src="${esc(p.img)}" alt="">` : `<span class="ti">${esc(sym[0])}</span>`}
      <div class="tm"><b>$${esc(sym)} · ${esc(d.reason || 'Groky')}</b><small>${fmtPct(d.pct)} · fermé ${dm(d.at)}</small></div>
      <span class="tv ${d.pnl > 0 ? 'up' : d.pnl < 0 ? 'down' : ''}">${fmtSignedUsd(d.pnl)}</span></a>`; }).join('');
  const k = rows; if (el._k === k) return; el._k = k;
  el.innerHTML = ct.length > 4 ? `<div class="roll" style="--dur:${ct.length * 3}s">${rows}${rows}</div>` : rows;
}
function renderGoal() {
  const t = totals(); const m = t ? t.total / S.base.usd : null;
  const pos = m != null ? Math.max(0, Math.min(100, m / 10 * 100)) : 0;
  $('gDot').style.left = pos + '%'; $('gFill').style.width = pos + '%';
  document.querySelectorAll('.g-mk').forEach((mk, i) => mk.classList.toggle('hit', m != null && m >= [3, 5, 7, 9][i]));
  $('gPct').textContent = m != null ? nf(m, 2) + '×' : DASH;
  $('goal').title = m != null ? `Valeur actuelle / base = ${nf(m, 3)}× (objectif 10×)` : '';
}

// ---------- sparklines ----------
function drawSpark(canvas, series, color, born, now) {
  const dpr = Math.min(3, devicePixelRatio || 1), r = canvas.getBoundingClientRect(); if (!r.width) return;
  if (canvas.width !== Math.round(r.width * dpr)) { canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); const W = r.width, H = r.height; ctx.clearRect(0, 0, W, H);
  if (series.length < 2) { ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke(); ctx.setLineDash([]); return; }
  let lo = Math.min(...series), hi = Math.max(...series); const sp = hi - lo || Math.abs(hi) * 0.001 || 1; lo -= sp * .15; hi += sp * .15;
  const n = series.length, pad = 6, X = i => pad + i / (n - 1) * (W - pad * 2), Y = v => 3 + (1 - (v - lo) / (hi - lo)) * (H - 6);
  const prog = Math.min(1, (now - born) / 1400), e = 1 - Math.pow(1 - prog, 3), upto = e * (n - 1);
  ctx.beginPath(); let lx = X(0), ly = Y(series[0]); ctx.moveTo(lx, ly);
  for (let i = 1; i <= Math.floor(upto); i++) { lx = X(i); ly = Y(series[i]); ctx.lineTo(lx, ly); }
  const f = upto - Math.floor(upto); if (f > 0 && Math.ceil(upto) < n) { const i = Math.ceil(upto); lx = X(i - 1) + (X(i) - X(i - 1)) * f; ly = Y(series[i - 1]) + (Y(series[i]) - Y(series[i - 1])) * f; ctx.lineTo(lx, ly); }
  ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.shadowColor = color; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
  ctx.lineTo(lx, H); ctx.lineTo(X(0), H); ctx.closePath(); const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, color + '33'); g.addColorStop(1, color + '00'); ctx.fillStyle = g; ctx.fill();
  const pu = (Math.sin(now / 280) + 1) / 2;
  ctx.beginPath(); ctx.arc(lx, ly, 3 + pu * 4, 0, 7); ctx.fillStyle = color + '40'; ctx.fill();
  ctx.beginPath(); ctx.arc(lx, ly, 2.8, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
}
const sinceBorn = performance.now();
function loop(now) {
  if (!document.hidden) {
    for (const a of AG) { const s = sparks[a.k]; if (s) drawSpark(s.canvas, s.series, s.color, s.born, now); }
    drawSpark($('sinceSpark'), S.equity.filter(p => p.t >= Date.now() - 24 * 3600e3).map(p => p.v), '#FF6B00', sinceBorn, now);
  }
  requestAnimationFrame(loop);
}

// ---------- notifications ----------
function toast(title, sub, badge, cls) {
  const box = $('toasts'); const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = `<img src="icons/icon-192.png?v=3" alt=""><div class="tt"><small>brokeboy · maintenant</small><b>${esc(title)}</b><span>${esc(sub || '')}</span></div>${badge ? `<span class="tb ${cls || ''}">${esc(badge)}</span>` : ''}`;
  box.prepend(el); while (box.children.length > 3) box.lastChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, 6000);
}
function balanceToast(prev, now) {
  const d = now - prev, sp = S.prices[SOL_MINT]?.price;
  toast('Solde mis à jour', `${nf(prev, 4)} → ${nf(now, 4)} SOL`, sp ? fmtSignedUsd(d * sp) : fmtSignedSol(d), d >= 0 ? 'up' : 'down');
}
function tradeToast(r) {
  const buy = /buy|achat/i.test(r.action || ''); const sym = r.token || S.prices[r.mint]?.symbol || short(r.mint);
  const ct = (closedTrades() || []).find(d => d.mint === r.mint);
  const badge = !buy && ct?.pnl != null ? fmtSignedUsd(ct.pnl) : fmtUsd(r.value_usd);
  toast(`${buy ? 'Achat' : 'Vente'} $${sym}`, r.reason || '', badge, !buy && ct?.pnl != null ? (ct.pnl >= 0 ? 'up' : 'down') : '');
}

// ---------- add funds ----------
function bindFunds() {
  const b = $('copyBtn');
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(S.wallet); }
    catch { const ta = document.createElement('textarea'); ta.value = S.wallet; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    b.textContent = 'Copié ✓'; b.classList.replace('orange', 'green');
    setTimeout(() => { b.textContent = "Copier l'adresse"; b.classList.replace('green', 'orange'); }, 2200);
  };
  $('phantomBtn').href = `https://phantom.app/ul/browse/${encodeURIComponent(location.href.split('#')[0])}?ref=${encodeURIComponent(location.origin)}`;
}

// ---------- navigation ----------
function bindNav() {
  const panes = $('panes'), tabs = [...document.querySelectorAll('.tabs button')];
  const cur = () => Math.round(panes.scrollLeft / Math.max(1, panes.clientWidth));
  const sync = () => { const i = cur(); tabs.forEach((t, j) => t.classList.toggle('on', i === j)); $('goal').classList.toggle('hide', innerWidth < 960 && i === 0); };
  tabs.forEach((t, i) => t.onclick = () => panes.scrollTo({ left: i * panes.clientWidth, behavior: 'smooth' }));
  panes.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });
  addEventListener('resize', sync);
  if (location.hash === '#agents') requestAnimationFrame(() => { panes.scrollLeft = panes.clientWidth; sync(); });
  sync();
}

// ---------- démarrage ----------
function every(fn, ms) { setInterval(() => { if (!document.hidden) fn(); }, ms); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshState(); refreshWallet(); refreshPrices(); } });
bindFunds(); bindNav(); render();
refreshState().then(() => { if (!S.state) { refreshWallet(); refreshPrices(); } });
every(refreshWallet, T_WALLET); every(refreshPrices, T_PRICES); every(refreshState, T_STATE);
setInterval(() => { renderLive(); if (S.state) renderAgents(); }, 5000);
requestAnimationFrame(loop);
})();
