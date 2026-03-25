// ── Config ──
const CORS_PROXIES = [
  url => url,
  url => 'https://corsproxy.io/?' + encodeURIComponent(url),
  url => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
  url => 'https://thingproxy.freeboard.io/fetch/' + encodeURIComponent(url),
  url => 'https://cors-proxy.htmldriven.com/?url=' + encodeURIComponent(url),
];

// ── CORS Proxy Circuit Breaker ──
// Track failing proxies and skip them temporarily to avoid repeated timeouts
const PROXY_FAIL_THRESHOLD = 2;   // failures before circuit opens
const PROXY_COOLDOWN_MS = 60000;  // 1 minute cooldown after circuit opens
const proxyFailCounts = {};       // { 'corsproxy.io': { count: 2, until: timestamp } }

function isProxyAvailable(proxyFn) {
  const key = getProxyKey(proxyFn);
  const state = proxyFailCounts[key];
  if (!state) return true;
  if (Date.now() > state.until) { delete proxyFailCounts[key]; return true; }
  return false;
}

function reportProxyFailure(proxyFn) {
  const key = getProxyKey(proxyFn);
  if (!proxyFailCounts[key]) proxyFailCounts[key] = { count: 0, until: 0 };
  proxyFailCounts[key].count++;
  if (proxyFailCounts[key].count >= PROXY_FAIL_THRESHOLD) {
    proxyFailCounts[key].until = Date.now() + PROXY_COOLDOWN_MS;
    console.warn(`[CORS] Proxy "${key}" circuit opened (${PROXY_COOLDOWN_MS/1000}s cooldown)`);
  }
}

function reportProxySuccess(proxyFn) {
  const key = getProxyKey(proxyFn);
  if (proxyFailCounts[key]) delete proxyFailCounts[key];
}

function getProxyKey(fn) {
  const s = fn.toString();
  if (s === 'url => url') return 'direct';
  const m = s.match(/https?:\/\/([^/]+)/);
  return m ? m[1] : s.slice(0, 40);
}

// ── CoinGecko Request Queue ──
// Enforces minimum interval between requests to avoid 429 rate limits
const CG_MIN_INTERVAL_MS = 1200; // 1.2s between CoinGecko requests
let _cgQueue = Promise.resolve();

function cgThrottle(fn) {
  _cgQueue = _cgQueue.then(() => {
    return new Promise(resolve => setTimeout(resolve, CG_MIN_INTERVAL_MS)).then(fn);
  });
  return _cgQueue;
}

function cgFetch(url, ms) {
  return cgThrottle(() => fetchWithCors(url, ms));
}

const APIS = [
  { name: 'Gate.io',  price: s => `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${s}_USDT`, parse: d => { const v = Array.isArray(d)?d[0]:null; return v ? {p:parseFloat(v.last),h:parseFloat(v.high_24h)||0,l:parseFloat(v.low_24h)||0,v:parseFloat(v.quote_volume_24h)||0,c:parseFloat(v.change_percentage)||0} : null; } },
  { name: 'Binance',  price: s => `https://api.binance.com/api/v3/ticker/24hr?symbol=${s}USDT`, parse: d => d?.lastPrice ? {p:parseFloat(d.lastPrice),h:parseFloat(d.highPrice)||0,l:parseFloat(d.lowPrice)||0,v:parseFloat(d.quoteVolume)||0,c:parseFloat(d.priceChangePercent)||0} : null },
  { name: 'OKX',      price: s => `https://www.okx.com/api/v5/market/ticker?instId=${s}-USDT`, parse: d => { const v=d?.data?.[0]; if(!v)return null; const l=parseFloat(v.last),o=parseFloat(v.open24h); return {p:l,h:parseFloat(v.high24h)||0,l:parseFloat(v.low24h)||0,v:parseFloat(v.volCcy24h)||0,c:o?((l-o)/o*100):0}; } },
  { name: 'MEXC',     price: s => `https://api.mexc.com/api/v3/ticker/24hr?symbol=${s}USDT`, parse: d => d?.lastPrice ? {p:parseFloat(d.lastPrice),h:parseFloat(d.highPrice)||0,l:parseFloat(d.lowPrice)||0,v:parseFloat(d.quoteVolume)||0,c:parseFloat(d.priceChangePercent)||0} : null },
  { name: 'Bitget',   price: s => `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${s}USDT`, parse: d => { const v=d?.data?.[0]; return v ? {p:parseFloat(v.lastPr),h:parseFloat(v.high24h)||0,l:parseFloat(v.low24h)||0,v:parseFloat(v.usdtVolume)||0,c:parseFloat(v.change24h)||0} : null; } },
  { name: 'HTX',      price: s => `https://api.huobi.pro/market/detail/merged?symbol=${s.toLowerCase()}usdt`, parse: d => { const v=d?.tick; if(!v)return null; return {p:v.close,h:v.high||0,l:v.low||0,v:v.vol||0,c:v.open?((v.close-v.open)/v.open*100):0}; } },
];

const DEFAULT_COINS = [
  { symbol: 'BTC', name: 'Bitcoin' },
  { symbol: 'ETH', name: 'Ethereum' },
  { symbol: 'WLFI', name: 'World Liberty Financial' },
];

// ── State ──
let coins = loadCoins();
let activeApi = parseInt(localStorage.getItem('crypto_api') || '-1');
let coinApiMap = loadCoinApiMap();
let refreshSec = parseInt(localStorage.getItem('crypto_refresh') || '5');
let timer = null;
let currency = localStorage.getItem('crypto_currency') || 'USD';
let currencyRates = { USD: 1, CNY: 7.25, EUR: 0.92 };
let alerts = loadAlerts();
let forceAlerts = loadForceAlerts();        // 强制预警配置
let forceAlertSnapshots = loadForceSnapshots(); // 价格快照（持久化，刷新不丢）
const FORCE_SNAPSHOT_INTERVAL_MS = 15000;   // 每15秒记录一次快照
const FORCE_SNAPSHOT_MAX_AGE_MS = 25*3600*1000; // 最多保留25小时快照（支持24h窗口）
let forceMonitorTimer = null;               // 统一调度定时器（替代每币种独立定时器）
let sortState = { key: null, asc: true };
let priceHistory = {}; // { 'BTC': [p1, p2, ...] } for sparklines
let prevPrices = {};   // { 'BTC': lastPrice } for flash animation
let soundEnabled = localStorage.getItem('crypto_sound') !== '0'; // default on
let voiceEnabled = localStorage.getItem('crypto_voice') === '1'; // default off (user opt-in)
let spellSymbols = localStorage.getItem('crypto_spell') === '1'; // default off: Chinese name → letter-by-letter
// audioCtx defined in Sound Engine section below
let isLightTheme = localStorage.getItem('crypto_theme') === 'light';
let colorInverted = localStorage.getItem('crypto_color_invert') === '1';

// ── WebSocket State ──
const WS_MAJOR_SYMBOLS = new Set([
  'BTC','ETH','BNB','SOL','XRP','ADA','DOGE','TRX','AVAX','DOT',
  'LINK','MATIC','UNI','SHIB','LTC','BCH','ATOM','XLM','NEAR','APT',
  'ARB','OP','FIL','INJ','SUI','PEPE','SEI','WLD','TIA','ORDI',
  'AAVE','MKR','SNX','COMP','CRV','LDO','STX','IMX','RNDR','FET',
]);
const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws/';
const BINANCE_WS_COMBINED = 'wss://stream.binance.com:9443/stream?streams=';
const OKX_WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';
const WS_BATCH_SIZE = 30; // Binance combined stream limit
const WS_OKX_BATCH_SIZE = 50; // OKX can handle more per connection
let wsConnections = [];    // active WebSocket instances { ws, provider, batchIdx, symbols }
let wsManagedSymbols = new Set(); // symbols currently on WS
let wsProviderOf = {};    // { 'BTC': 'binance' | 'okx' } — which provider each symbol uses
let wsReconnectTimers = {};
let wsRetryCount = {};  // { connKey: consecutiveRetryCount }

function isWsEligible(sym) { return WS_MAJOR_SYMBOLS.has(sym); }

function wsGetBackoffDelay(connKey, baseMs) {
  wsRetryCount[connKey] = (wsRetryCount[connKey] || 0) + 1;
  const exp = Math.min(baseMs * Math.pow(2, wsRetryCount[connKey] - 1), 30000);
  const jitter = Math.random() * baseMs * 0.5;
  return Math.round(exp + jitter);
}

// ── Persistence ──
function loadCoins() {
  let raw;
  try { const s = localStorage.getItem('crypto_coins_v4'); if (s) raw = JSON.parse(s); } catch {}
  if (!raw) return DEFAULT_COINS.map(c => ({...c}));
  // Deduplicate by symbol (keep first occurrence) — localStorage can get dupes from older versions or cross-tab writes
  const seen = new Set();
  return raw.filter(c => {
    const sym = (c.symbol || '').toUpperCase();
    if (!sym || seen.has(sym)) return false;
    seen.add(sym);
    return true;
  });
}
function saveCoins() { localStorage.setItem('crypto_coins_v4', JSON.stringify(coins)); }
function loadCoinApiMap() { try { const s=localStorage.getItem('crypto_coin_api'); if(s)return JSON.parse(s); } catch{} return {}; }
function saveCoinApiMap() { localStorage.setItem('crypto_coin_api', JSON.stringify(coinApiMap)); }
function loadAlerts() { try { const s=localStorage.getItem('crypto_alerts'); if(s)return JSON.parse(s); } catch{} return []; }
function saveAlerts() { localStorage.setItem('crypto_alerts', JSON.stringify(alerts)); }
function loadForceAlerts() { try { const s=localStorage.getItem('crypto_force_alerts'); if(s)return JSON.parse(s); } catch{} return []; }
function saveForceAlerts() { localStorage.setItem('crypto_force_alerts', JSON.stringify(forceAlerts)); }
function loadForceSnapshots() {
  try {
    const s = localStorage.getItem('crypto_force_snaps');
    if (s) {
      const data = JSON.parse(s);
      // 清理过期快照
      const cutoff = Date.now() - FORCE_SNAPSHOT_MAX_AGE_MS;
      for (const sym in data) {
        data[sym] = data[sym].filter(sn => sn.t >= cutoff);
        if (!data[sym].length) delete data[sym];
      }
      return data;
    }
  } catch {}
  return {};
}
// 快照持久化节流：避免每15秒都写localStorage
let _lastSnapSave = 0;
function saveForceSnapshotsThrottled() {
  const now = Date.now();
  if (now - _lastSnapSave < 60000) return; // 最多每60秒存一次
  _lastSnapSave = now;
  try { safeSetItem('crypto_force_snaps', JSON.stringify(forceAlertSnapshots)); } catch {}
}

// ── localStorage 配额保护 ──
// 安全写入：写满时自动清理旧的价格历史数据
function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.code === 22) {
      console.warn('[Storage] localStorage 已满，清理旧数据…');
      prunePriceHistory(100); // 保留最近 100 条
      try { localStorage.setItem(key, value); } catch { console.warn('[Storage] 清理后仍无法写入'); }
    }
  }
}

// 修剪价格历史（保留最近 N 条），释放存储空间
function prunePriceHistory(maxLen) {
  for (const sym in priceHistory) {
    if (priceHistory[sym].length > maxLen) {
      priceHistory[sym] = priceHistory[sym].slice(-maxLen);
    }
  }
}

// ── Formatting ──
function fmt(n) {
  if (n==null||isNaN(n)) return '—';
  const r = currency !== 'USD' ? n * currencyRates[currency] : n;
  const prefix = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : '€';
  return prefix + (r >= 1000 ? r.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})
    : r >= 1 ? r.toFixed(2)
    : r >= 0.01 ? r.toFixed(4)
    : r.toFixed(8));
}
function fmtRaw(n) {
  if (n==null||isNaN(n)) return '—';
  return n >= 1 ? n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})
    : n < 0.01 ? n.toFixed(8) : n.toFixed(4);
}
function fmtVol(n) {
  if (n==null||isNaN(n)||n===0) return '—';
  if (n >= 1e8) return (n/1e8).toFixed(2) + '亿 USDT';
  if (n >= 1e4) return (n/1e4).toFixed(2) + '万 USDT';
  return n.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:2}) + ' USDT';
}

// ── CORS-aware fetch with circuit breaker ──
async function fetchWithCors(url, ms = 6000) {
  const errors = [];
  for (const makeUrl of CORS_PROXIES) {
    if (!isProxyAvailable(makeUrl)) continue; // skip tripped circuit
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(makeUrl(url), { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) { reportProxySuccess(makeUrl); return await r.json(); }
      errors.push(`${getProxyKey(makeUrl)}: HTTP ${r.status}`);
      reportProxyFailure(makeUrl);
    } catch (e) {
      clearTimeout(t);
      errors.push(`${getProxyKey(makeUrl)}: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
      reportProxyFailure(makeUrl);
    }
  }
  const err = new Error('all proxies failed: ' + errors.join(', '));
  err.isNetworkError = true;
  throw err;
}

// ── Concurrency limiter ──
async function limitPool(tasks, max = 6) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]().catch(e => ({ error: e }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(max, tasks.length) }, () => worker()));
  return results;
}

// ── Init selects ──
function initSelects() {
  const apiSelect = document.getElementById('apiSelect');
  APIS.forEach((api, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = api.name;
    apiSelect.appendChild(opt);
  });
  apiSelect.value = activeApi;
  document.getElementById('refreshSelect').value = refreshSec;
  document.getElementById('currencySelect').value = currency;
}

function pickApi(i) {
  activeApi = parseInt(i);
  localStorage.setItem('crypto_api', activeApi);
  if (activeApi >= 0) { coins.forEach(c => { coinApiMap[c.symbol] = activeApi; }); saveCoinApiMap(); }
  fetchPrices();
}

function setCurrency(c) {
  currency = c;
  localStorage.setItem('crypto_currency', c);
  fetchPrices();
}

function setInterval_(sec) {
  refreshSec = sec;
  localStorage.setItem('crypto_refresh', sec);
  clearInterval(timer);
  timer = setInterval(fetchPrices, sec * 1000);
  updateWsStatus();
  fetchPrices();
}

// ── Sorting ──
function sortBy(key) {
  document.querySelectorAll('.table-head span').forEach(s => s.classList.remove('sort-active'));
  if (sortState.key === key) {
    sortState.asc = !sortState.asc;
  } else {
    sortState.key = key;
    sortState.asc = key === 'change' ? false : true; // default: change desc
  }
  const el = document.getElementById('sort-' + key);
  if (el) {
    el.classList.add('sort-active');
    el.querySelector('.sort-arrow').textContent = sortState.asc ? '▲' : '▼';
  }
  render();
}

function getSortedCoins() {
  if (!sortState.key) return [...coins];
  const k = sortState.key;
  const dir = sortState.asc ? 1 : -1;
  return [...coins].sort((a, b) => {
    const va = priceHistory[a.symbol] ? getSortVal(a.symbol, k) : -Infinity;
    const vb = priceHistory[b.symbol] ? getSortVal(b.symbol, k) : -Infinity;
    return (va - vb) * dir;
  });
}

function getSortVal(sym, key) {
  const ph = priceHistory[sym];
  if (!ph || !ph.length) return 0;
  const last = ph[ph.length - 1];
  switch (key) {
    case 'price': return last.p || 0;
    case 'high': return last.h || 0;
    case 'low': return last.l || 0;
    case 'vol': return last.v || 0;
    case 'change': return last.c || 0;
    default: return 0;
  }
}

// ── Sparkline SVG ──
function sparklineSvg(sym) {
  const hist = priceHistory[sym];
  if (!hist || hist.length < 2) return '';
  const prices = hist.map(h => h.p).filter(p => p > 0);
  if (prices.length < 2) return '';
  const w = 70, h = 22;
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const points = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * w;
    const y = h - ((p - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = prices[prices.length - 1];
  const first = prices[0];
  const color = last >= first ? 'var(--green)' : 'var(--red)';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${w}" cy="${h - ((last - min) / range) * h}" r="2" fill="${color}"/>
  </svg>`;
}

// ── Render ──
// 增量更新策略：仅在币种列表或排序状态变化时全量重建 DOM，行情数据由 applyCoinData 增量更新
// force=true 时强制重建（用于预警/持仓等需要刷新标签的场景）
let _lastRenderKey = '';
function render(force) {
  const el = document.getElementById('rows');
  const emp = document.getElementById('empty');
  const sorted = getSortedCoins();
  if (!sorted.length) { el.innerHTML = ''; emp.style.display = ''; return; }
  emp.style.display = 'none';

  const renderKey = sorted.map(c => c.symbol).join(',') + '|' + sortState.key + '|' + sortState.asc;
  if (!force && renderKey === _lastRenderKey) return;
  _lastRenderKey = renderKey;

  el.innerHTML = sorted.map((c) => {
    const sym = c.symbol;
    const origIdx = coins.findIndex(x => x.symbol === sym);
    const apiIdx = coinApiMap[sym];
    const apiTag = apiIdx != null && APIS[apiIdx]
      ? `<span class="api-badge" data-api="${sym}">${APIS[apiIdx].name}</span>`
      : `<span class="api-badge api-probing" data-api="${sym}">探测中…</span>`;
    const hasAlert = alerts.some(a => a.symbol === sym);
    const alertTag = hasAlert ? `<span class="alert-indicator" title="已设置预警">🔔</span>` : '';
    const pnlTag = portfolio.some(p => p.symbol === sym) ? getPnlHtml(sym) : '';
    const ph = priceHistory[sym];
    const last = ph && ph.length ? ph[ph.length - 1] : null;

    return `<div class="table-row" id="row-${sym}" data-sym="${sym}">
      <button class="remove-btn" onclick="removeCoin(${origIdx})" title="移除">✕</button>
      <div class="coin-info">
        <span class="coin-sym">${escapeHtml(sym)}${apiTag}${alertTag}</span>
        <span class="coin-name">${escapeHtml(c.name||'')} ${pnlTag}</span>
      </div>
      <div class="coin-price" id="p-${sym}"><span class="card-label">最新价</span><span class="card-value">${last ? fmt(last.p) : '—'}</span></div>
      <div class="coin-change" id="c-${sym}" style="${last ? 'color:' + (last.c >= 0 ? 'var(--green)' : 'var(--red)') : ''}"><span class="card-label">涨跌幅</span><span class="card-value">${last ? (last.c>=0?'+':'')+last.c.toFixed(2)+'%' : '—'}</span></div>
      <div class="sparkline-cell" id="sp-${sym}">${sparklineSvg(sym)}</div>
      <div class="coin-high" id="h-${sym}"><span class="card-label">24h最高</span><span class="card-value">${last && last.h ? fmt(last.h) : '—'}</span></div>
      <div class="coin-low" id="l-${sym}"><span class="card-label">24h最低</span><span class="card-value">${last && last.l ? fmt(last.l) : '—'}</span></div>
      <div class="coin-vol" id="v-${sym}"><span class="card-label">24h成交额</span><span class="card-value">${last ? fmtVol(last.v) : '—'}</span></div>
    </div>`;
  }).join('');
}

// ── Coin CRUD ──
function addCoin(sym, name) {
  sym = sym.toUpperCase().replace(/[^A-Z0-9]/g,'');
  if (!sym || coins.find(c=>c.symbol===sym)) { if (sym) showToast(`${sym} 已在自选列表中`, 'error'); return; }
  coins.push({symbol:sym, name:name||sym}); saveCoins();
  if (activeApi >= 0) { coinApiMap[sym] = activeApi; saveCoinApiMap(); }
  render();
  if (isWsEligible(sym)) { wsResync(); fetchPrices(); } else { fetchPrices(); }
}
function removeCoin(i) {
  const sym = coins[i].symbol;
  delete coinApiMap[sym]; saveCoinApiMap();
  delete priceHistory[sym];
  delete prevPrices[sym];
  delete wsProviderOf[sym];
  wsManagedSymbols.delete(sym);
  // Remove ALL entries with this symbol (defensive against dupes)
  coins = coins.filter(c => c.symbol !== sym); saveCoins();
  render();
  wsResync();
  fetchPrices();
}
function addFromInput() {
  const v = document.getElementById('input').value.trim();
  if (v) { addCoin(v); document.getElementById('input').value=''; }
}
// Enter 已由 HTML onkeydown="onSearchKey(event)" 处理，无需重复绑定

// ── Apply coin data (shared by WS + polling) ──
function applyCoinData(sym, data, sourceLabel) {
  const { p, h, l, v, c: ch } = data;

  // Update price history (keep last 200 for RSI etc.)
  if (!priceHistory[sym]) priceHistory[sym] = [];
  priceHistory[sym].push({ p, h, l, v, c: ch, t: Date.now() });
  if (priceHistory[sym].length > 200) priceHistory[sym].shift();

  // Flash animation
  const prev = prevPrices[sym];
  let flashClass = '';
  if (prev != null && prev !== p) {
    flashClass = p > prev ? 'flash-up' : 'flash-down';
  }
  prevPrices[sym] = p;

  // DOM update (增量更新单个币种，避免全量重建)
  const pEl = document.getElementById('p-' + sym);
  const hEl = document.getElementById('h-' + sym);
  const lEl = document.getElementById('l-' + sym);
  const vEl = document.getElementById('v-' + sym);
  const cEl = document.getElementById('c-' + sym);
  const spEl = document.getElementById('sp-' + sym);
  const row = document.getElementById('row-' + sym);

  if (pEl) { const pv = pEl.querySelector('.card-value') || pEl; pv.textContent = fmt(p); if (flashClass) { pEl.classList.remove('flash-up', 'flash-down'); void pEl.offsetWidth; pEl.classList.add(flashClass); } }
  if (hEl) { const hv = hEl.querySelector('.card-value') || hEl; hv.textContent = h ? fmt(h) : '—'; }
  if (lEl) { const lv = lEl.querySelector('.card-value') || lEl; lv.textContent = l ? fmt(l) : '—'; }
  if (vEl) { const vv = vEl.querySelector('.card-value') || vEl; vv.textContent = fmtVol(v); }
  if (cEl) { const cv = cEl.querySelector('.card-value') || cEl; cv.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%'; cEl.style.color = ch >= 0 ? 'var(--green)' : 'var(--red)'; }
  if (row) { row.className = 'table-row ' + (ch >= 0 ? 'up' : 'down'); }
  if (spEl) spEl.innerHTML = sparklineSvg(sym);

  // 增量更新持仓 P&L 标签（不再需要全量 render）
  if (row && portfolio.some(p => p.symbol === sym)) {
    const nameSpan = row.querySelector('.coin-name');
    if (nameSpan) {
      const c = coins.find(c => c.symbol === sym);
      const pnlTag = getPnlHtml(sym);
      nameSpan.innerHTML = escapeHtml(c ? c.name : sym) + ' ' + pnlTag;
    }
  }

  // Source badge
  const badge = document.querySelector('[data-api="' + sym + '"]');
  if (badge && sourceLabel) {
    badge.textContent = sourceLabel;
    if (sourceLabel === 'Binance WS') {
      badge.className = 'api-badge ws-badge ws-binance';
    } else if (sourceLabel === 'OKX WS') {
      badge.className = 'api-badge ws-badge ws-okx';
    } else {
      badge.className = 'api-badge';
    }
  }

  // Check alerts
  checkAlerts(sym, p);

  // Record price snapshot for force alert window tracking
  recordForceSnapshot(sym, p);
}

// ── Multi-Provider WebSocket Manager (Binance primary → OKX fallback) ──
function getWsSymbols() {
  return coins.filter(c => isWsEligible(c.symbol)).map(c => c.symbol);
}

function getPollSymbols() {
  return coins.filter(c => !isWsEligible(c.symbol)).map(c => c.symbol);
}

function wsCloseAll() {
  wsConnections.forEach(conn => {
    clearInterval(conn._pingInterval);
    try { conn.ws.close(); } catch {}
  });
  wsConnections = [];
  Object.values(wsReconnectTimers).forEach(t => clearTimeout(t));
  wsReconnectTimers = {};
  wsRetryCount = {};
  wsManagedSymbols.clear();
  wsProviderOf = {};
}

function binanceWsConnect() {
  wsCloseAll();

  const symbols = getWsSymbols();
  if (!symbols.length) { updateWsStatus(); return; }

  // Batch for Binance
  const batches = [];
  for (let i = 0; i < symbols.length; i += WS_BATCH_SIZE) {
    batches.push(symbols.slice(i, i + WS_BATCH_SIZE));
  }

  // Connect Binance primary
  batches.forEach((batch, idx) => {
    wsConnectBinanceBatch(batch, 'b' + idx);
  });

  // Connect OKX as fallback (all symbols in one or two connections)
  const okxBatches = [];
  for (let i = 0; i < symbols.length; i += WS_OKX_BATCH_SIZE) {
    okxBatches.push(symbols.slice(i, i + WS_OKX_BATCH_SIZE));
  }
  okxBatches.forEach((batch, idx) => {
    wsConnectOkxBatch(batch, 'o' + idx);
  });

  // Initially mark all as Binance (primary); OKX data will override if Binance is late
  symbols.forEach(s => { wsProviderOf[s] = 'binance'; });
  wsManagedSymbols = new Set(symbols);
  updateWsStatus();
}

// ── Binance WS ──
function wsConnectBinanceBatch(symbols, connKey) {
  const streams = symbols.map(s => s.toLowerCase() + 'usdt@ticker').join('/');
  const url = BINANCE_WS_BASE + streams;

  try {
    const ws = new WebSocket(url);
    const conn = { ws, provider: 'binance', connKey, symbols };
    ws._conn = conn;

    ws.onopen = () => {
      wsRetryCount[connKey] = 0;
      updateWsStatus();
      // ── Binance WS 保活: 发送 JSON ping 每 3 分钟 ──
      // Binance stream API 支持 {"method":"ping"} 来检测连接活性
      conn._pingInterval = setInterval(() => {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ method: 'ping' }));
          }
        } catch {}
      }, 180000); // 3 分钟（Binance 建议的 ping 间隔）
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const d = msg.data || msg;
        const sym = (d.s || '').replace('USDT', '');
        if (!sym) return;

        const p = parseFloat(d.c), h = parseFloat(d.h), l = parseFloat(d.l);
        const v = parseFloat(d.q), ch = parseFloat(d.P);
        if (isNaN(p)) return;

        // Binance is primary — always accept
        wsProviderOf[sym] = 'binance';
        wsManagedSymbols.add(sym);
        applyCoinData(sym, { p, h, l, v, c: ch }, 'Binance WS');
      } catch (e) { console.warn('[Binance WS] parse error:', e.message); }
    };

    ws.onerror = (e) => { console.warn(`[Binance WS] error on ${connKey}`); ws.close(); };
    ws.onclose = () => {
      clearInterval(conn._pingInterval);
      updateWsStatus();
      const delay = wsGetBackoffDelay(connKey, 2000);
      clearTimeout(wsReconnectTimers[connKey]);
      wsReconnectTimers[connKey] = setTimeout(() => {
        wsConnectBinanceBatch(symbols, connKey);
      }, delay);
    };

    wsConnections.push(conn);
  } catch {}
}

// ── OKX WS (fallback) ──
function wsConnectOkxBatch(symbols, connKey) {
  try {
    const ws = new WebSocket(OKX_WS_URL);
    const conn = { ws, provider: 'okx', connKey, symbols };
    ws._conn = conn;

    ws.onopen = () => {
      wsRetryCount[connKey] = 0;
      // Subscribe to tickers
      const args = symbols.map(s => ({
        channel: 'tickers',
        instId: s.toUpperCase() + '-USDT'
      }));
      ws.send(JSON.stringify({ op: 'subscribe', args }));
      updateWsStatus();

      // OKX requires ping every 30s to keep alive
      conn._pingInterval = setInterval(() => {
        try { ws.send('ping'); } catch {}
      }, 25000);
    };

    ws.onmessage = (event) => {
      // OKX sends 'pong' responses
      if (event.data === 'pong') return;

      try {
        const msg = JSON.parse(event.data);
        if (msg.event === 'subscribe' || msg.arg) return; // subscription ack

        const arr = msg.data;
        if (!Array.isArray(arr)) return;

        arr.forEach(d => {
          const instId = d.instId || '';
          const sym = instId.replace('-USDT', '').replace('-usdt', '');
          if (!sym) return;

          const p = parseFloat(d.last);
          const h = parseFloat(d.high24h);
          const l = parseFloat(d.low24h);
          const v = parseFloat(d.volCcy24h);
          const o = parseFloat(d.open24h);
          const ch = o ? ((p - o) / o * 100) : 0;

          if (isNaN(p)) return;

          // OKX is fallback — only accept if Binance hasn't provided data recently
          // or if this is the first data for this symbol
          const existing = priceHistory[sym];
          const lastTs = existing && existing.length ? existing[existing.length - 1].t : 0;
          const binanceStale = (Date.now() - lastTs) > 15000; // Binance data > 15s old

          if (!wsProviderOf[sym] || wsProviderOf[sym] === 'okx' || binanceStale) {
            wsProviderOf[sym] = 'okx';
            wsManagedSymbols.add(sym);
            applyCoinData(sym, { p, h, l, v, c: ch }, 'OKX WS');
          }
        });
      } catch (e) { console.warn('[OKX WS] parse error:', e.message); }
    };

    ws.onerror = (e) => { console.warn(`[OKX WS] error on ${connKey}`); ws.close(); };
    ws.onclose = () => {
      clearInterval(conn._pingInterval);
      updateWsStatus();
      const delay = wsGetBackoffDelay(connKey, 3000);
      clearTimeout(wsReconnectTimers[connKey]);
      wsReconnectTimers[connKey] = setTimeout(() => {
        wsConnectOkxBatch(symbols, connKey);
      }, delay);
    };

    wsConnections.push(conn);
  } catch {}
}

// ── Shared ──
function wsResync() {
  const needed = new Set(getWsSymbols());
  const same = needed.size === wsManagedSymbols.size && [...needed].every(s => wsManagedSymbols.has(s));
  if (!same) {
    binanceWsConnect(); // reconnect both providers
  }
}

function updateWsStatus() {
  const wsCount = [...wsManagedSymbols].filter(s => coins.some(c => c.symbol === s)).length;
  const pollCount = coins.length - wsCount;
  const interval = refreshSec >= 60 ? `${refreshSec / 60}分钟` : `${refreshSec}秒`;

  if (wsCount > 0 && pollCount > 0) {
    document.getElementById('subText').textContent = `⚡${wsCount}实时 + 🔄${pollCount}轮询`;
  } else if (wsCount > 0) {
    document.getElementById('subText').textContent = 'WebSocket 实时推送中';
  } else {
    document.getElementById('subText').textContent = `每${interval}自动刷新`;
  }
}

// ── Fetch Prices (polling for non-WS coins only) ──
async function tryApi(api, sym) {
  const d = await fetchWithCors(api.price(sym), 6000);
  const res = api.parse(d);
  if (!res) throw new Error('no data');
  return res;
}

async function fetchPrices() {
  if (!coins.length) { setStatus('live', '无币种'); return; }

  // Only poll coins not managed by WebSocket
  const pollCoins = coins.filter(c => !wsManagedSymbols.has(c.symbol));

  if (!pollCoins.length && wsManagedSymbols.size > 0) {
    // All coins on WS, nothing to poll
    const binanceCount = Object.values(wsProviderOf).filter(p => p === 'binance').length;
    const okxCount = Object.values(wsProviderOf).filter(p => p === 'okx').length;
    const parts = [];
    if (binanceCount) parts.push(`Binance⚡${binanceCount}`);
    if (okxCount) parts.push(`OKX⚡${okxCount}`);
    setStatus('live', `${parts.join(' · ')} · ${new Date().toLocaleTimeString('zh-CN')}`);
    updateTabBadge();
    return;
  }

  const tasks = (pollCoins.length ? pollCoins : coins).map(c => async () => {
    let list;
    const prefIdx = coinApiMap[c.symbol];
    if (activeApi >= 0) {
      list = [APIS[activeApi], ...APIS.filter((_,i) => i !== activeApi)];
    } else if (prefIdx != null && APIS[prefIdx]) {
      list = [APIS[prefIdx], ...APIS.filter((_,i) => i !== prefIdx)];
    } else {
      list = [...APIS];
    }

    for (const api of list) {
      try {
        const res = await tryApi(api, c.symbol);
        const apiIdx = APIS.indexOf(api);

        applyCoinData(c.symbol, res, api.name);

        if (coinApiMap[c.symbol] !== apiIdx) {
          coinApiMap[c.symbol] = apiIdx;
          saveCoinApiMap();
        }

        return { api: api.name };
      } catch {}
    }
    // All failed
    const cEl = document.getElementById('c-'+c.symbol);
    if (cEl) { const cv = cEl.querySelector('.card-value') || cEl; cv.textContent = '失败'; cEl.style.color = 'var(--muted)'; }
    const badge = document.querySelector('[data-api="'+c.symbol+'"]');
    if (badge) { badge.textContent = '无数据'; badge.className = 'api-badge api-probing'; }
    return null;
  });

  const results = await limitPool(tasks, 6);
  const usedApis = new Set();
  let ok = 0;
  results.forEach(r => { if (r && r.api) { usedApis.add(r.api); ok++; } });

  const apiNames = [...usedApis].join(' / ');
  const wsCount = wsManagedSymbols.size;
  const total = coins.length;
  const pollOk = ok;
  const allOk = pollOk + wsCount;

  if (allOk > 0 || pollOk > 0) {
    const parts = [];
    if (wsCount > 0) {
      const bn = Object.values(wsProviderOf).filter(p => p === 'binance').length;
      const ox = Object.values(wsProviderOf).filter(p => p === 'okx').length;
      const wsParts = [];
      if (bn) wsParts.push(`Binance⚡${bn}`);
      if (ox) wsParts.push(`OKX⚡${ox}`);
      parts.push(wsParts.join('+'));
    }
    if (pollOk > 0) parts.push(`${apiNames || 'OK'}·${pollOk}poll`);
    parts.push(`${allOk}/${total}`);
    parts.push(new Date().toLocaleTimeString('zh-CN'));
    setStatus('live', parts.join(' · '));
  } else {
    setStatus('error', '全部失败 — ' + refreshSec + 's 后重试');
  }
  updateTabBadge();
}

function setStatus(t,m) { document.getElementById('dot').className='dot '+t; document.getElementById('status').textContent=m; }

// ── Sound Engine (Web Audio API) ──
let audioCtx = null; // lazy init AudioContext
let audioUnlocked = false; // iOS requires user gesture to unlock

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // iOS: may be suspended after background — resume on demand
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  // iOS: context may have been closed entirely — recreate
  if (audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

// iOS: unlock audio on first user gesture (required for PWA)
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    // Play a silent buffer to fully unlock
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    src.stop(0.001);
  } catch {}
  // Remove listeners after first unlock
  document.removeEventListener('touchstart', unlockAudio);
  document.removeEventListener('touchend', unlockAudio);
  document.removeEventListener('click', unlockAudio);
}

// Register unlock on first interaction
document.addEventListener('touchstart', unlockAudio, { once: false, passive: true });
document.addEventListener('touchend', unlockAudio, { once: false, passive: true });
document.addEventListener('click', unlockAudio, { once: false });

// ── AudioContext Health Recovery ──
// Browsers suspend/close AudioContext on lock screen, backgrounding, or memory pressure.
// We need aggressive recovery to keep sound working.

function recoverAudioContext() {
  try {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = null; // force recreate on next getAudioCtx()
      audioUnlocked = false;
      // Re-register unlock listeners
      document.addEventListener('touchstart', unlockAudio, { once: false, passive: true });
      document.addEventListener('touchend', unlockAudio, { once: false, passive: true });
      document.addEventListener('click', unlockAudio, { once: false });
      return;
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  } catch {
    audioCtx = null;
  }
}

// AudioContext 健康检查: 5秒间隔（平衡响应速度与电池消耗）
let _audioHealthTimer = setInterval(() => {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}, 5000);

// visibilitychange: resume on foreground
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Aggressive recovery on every foreground return
    recoverAudioContext();
    // Double-tap: resume again after a short delay (iOS sometimes needs this)
    setTimeout(recoverAudioContext, 300);
    setTimeout(recoverAudioContext, 1000);
  }
});

// pageshow (back/forward cache restore on iOS/Safari)
window.addEventListener('pageshow', (e) => {
  recoverAudioContext();
  setTimeout(recoverAudioContext, 500);
  // Restore notification toggle state on bfcache restore
  restoreNotifyToggleState();
});

// pagehide (iOS freezes page — prepare for recovery)
window.addEventListener('pagehide', () => {
  // Nothing to do here; recovery happens on pageshow
});

// freeze event (Chrome background freezing)
document.addEventListener('freeze', () => {
  // Will be unfrozen later; recoverAudioContext handles it
});

document.addEventListener('resume', () => {
  recoverAudioContext();
  setTimeout(recoverAudioContext, 500);
});

// ── HTML5 Audio Fallback ──
// When AudioContext is suspended (lock screen), HTML5 <audio> elements
// with user gesture history can still play. We use this as a fallback.
let _audioFallbackReady = false;
let _fallbackAudioEl = null;

// Audio fallback: 内联生成 WAV beep，用于 AudioContext 不可用时的兜底方案
function initFallbackAudio() {
  if (_audioFallbackReady) return;
  _audioFallbackReady = true;
  try {
    _fallbackAudioEl = new Audio();
    _fallbackAudioEl.preload = 'auto';
    _fallbackAudioEl.volume = 0.5;
    // Generate a short beep WAV inline
    const sampleRate = 22050;
    const duration = 0.15;
    const numSamples = Math.floor(sampleRate * duration);
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    // WAV header
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);
    // Fill with a sine wave beep (1047Hz)
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const envelope = Math.max(0, 1 - t / duration);
      const sample = Math.sin(2 * Math.PI * 1047 * t) * envelope * 0.5;
      view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), true);
    }
    const blob = new Blob([buffer], { type: 'audio/wav' });
    _fallbackAudioEl.src = URL.createObjectURL(blob);
  } catch {}
}

// Initialize fallback audio on first user gesture
document.addEventListener('touchstart', () => initFallbackAudio(), { once: true, passive: true });
document.addEventListener('click', () => initFallbackAudio(), { once: true });

function playFallbackBeep() {
  if (!_audioFallbackReady) initFallbackAudio();
  if (!_fallbackAudioEl) return;
  try {
    _fallbackAudioEl.currentTime = 0;
    _fallbackAudioEl.play().catch(() => {});
  } catch {}
}

// 小爱风格清脆提示音：两个快速上升音阶 + 余韵
function playAlertSound() {
  if (!soundEnabled) return;
  let played = false;
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;

    // 音符序列：模仿小爱的 "叮-叮-叮~" 风格
    const notes = [
      { freq: 880, start: 0,     dur: 0.12, vol: 0.35 },  // A5
      { freq: 1109, start: 0.14, dur: 0.12, vol: 0.35 },  // C#6
      { freq: 1319, start: 0.28, dur: 0.25, vol: 0.30 },  // E6 (尾音拉长)
    ];

    notes.forEach(n => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.freq, now + n.start);

      // 轻微滑音增加灵动感
      osc.frequency.linearRampToValueAtTime(n.freq * 1.02, now + n.start + n.dur * 0.3);
      osc.frequency.linearRampToValueAtTime(n.freq, now + n.start + n.dur);

      // 包络：快速起音 + 柔和衰减
      gain.gain.setValueAtTime(0, now + n.start);
      gain.gain.linearRampToValueAtTime(n.vol, now + n.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + n.start + n.dur);

      // 柔化高频，让声音更像语音助手
      filter.type = 'lowpass';
      filter.frequency.value = 3000;
      filter.Q.value = 0.5;

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.start);
      osc.stop(now + n.start + n.dur + 0.05);
    });
    played = true;
  } catch {}
  // Fallback: if AudioContext failed or is suspended, use HTML5 Audio
  if (!played) playFallbackBeep();
}

// 普通通知音（较短）
function playNotifySound() {
  if (!soundEnabled) return;
  let played = false;
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1047, now); // C6
    osc.frequency.linearRampToValueAtTime(1319, now + 0.08); // slide up to E6
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.25, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.25);
    played = true;
  } catch {}
  if (!played) playFallbackBeep();
}

// 价格突破时的紧急提示音（循环 2 次）
function playUrgentSound() {
  if (!soundEnabled) return;
  let played = false;
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    for (let rep = 0; rep < 2; rep++) {
      const offset = rep * 0.4;
      [880, 1175, 1319].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + offset + i * 0.1);
        gain.gain.linearRampToValueAtTime(0.3, now + offset + i * 0.1 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + i * 0.1 + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset + i * 0.1);
        osc.stop(now + offset + i * 0.1 + 0.15);
      });
    }
    played = true;
  } catch {}
  if (!played) { playFallbackBeep(); setTimeout(playFallbackBeep, 250); }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('crypto_sound', soundEnabled ? '1' : '0');
  document.getElementById('soundToggle').textContent = soundEnabled ? '🔊' : '🔇';
  if (soundEnabled) playNotifySound(); // test sound
}

function toggleVoice() {
  voiceEnabled = !voiceEnabled;
  localStorage.setItem('crypto_voice', voiceEnabled ? '1' : '0');
  document.getElementById('voiceToggle').textContent = voiceEnabled ? '🗣️' : '🔇';
  if (voiceEnabled) {
    initSpeechEngine();
    speakAlert('语音播报已开启');
  }
}

function toggleSpell() {
  spellSymbols = !spellSymbols;
  localStorage.setItem('crypto_spell', spellSymbols ? '1' : '0');
  document.getElementById('spellToggle').textContent = spellSymbols ? '🔤' : '🀄';
  document.getElementById('spellToggle').title = spellSymbols ? '币种名称读法：逐字母拼读' : '币种名称读法：中文名称';
  showToast(spellSymbols ? '币种将逐字母拼读 (如 B-T-C)' : '常见币种使用中文名称 (如 比特币)');
}

// ── 语音播报引擎 (v2 - 防静默失效) ──
// Web Speech API 有多个已知致命问题:
// 1. Chrome 后台挂起: speechSynthesis 被浏览器暂停但状态不变
// 2. iOS Safari 15秒bug: 播放约15秒后无声停止
// 3. 引擎卡在 paused 状态: resume() 无效
// 4. onend/onerror 都不触发 → 队列永久阻塞
// 5. 语音列表为空直到 voiceschanged 触发(但该事件有时也不触发)

let zhVoice = null;           // 缓存选中的中文语音
let speechReady = false;      // 引擎是否已预热
let pendingSpeech = [];       // 预热前的待播报队列
let speechQueue = [];         // 播报队列（确保依次播放不中断）
let speechPlaying = false;    // 当前是否正在播报中
let speechWatchdog = null;    // 当前播报的 watchdog 定时器
let speechKeepalive = null;   // 防挂起的 keepalive 定时器
let speechFailCount = 0;      // 连续失败次数（用于触发引擎重置）
let speechEngineResetting = false; // 正在重置引擎
const SPEECH_MAX_FAIL = 3;    // 连续失败 3 次触发引擎硬重置

// ─── 初始化 ───
function initSpeechEngine() {
  if (!('speechSynthesis' in window)) return;
  pickZhVoice();
  startSpeechKeepalive();

  if (!speechReady) {
    try {
      // 预热：用极短文本激活引擎
      speechSynthesis.cancel(); // 清空残留状态
      const warmUp = new SpeechSynthesisUtterance('.');
      warmUp.volume = 0.01;
      warmUp.rate = 10;
      const warmDone = () => { speechReady = true; flushPendingSpeech(); };
      warmUp.onend = warmDone;
      warmUp.onerror = warmDone;
      speechSynthesis.speak(warmUp);
      // 双重保险：如果 onend 不触发
      setTimeout(warmDone, 800);
    } catch {
      speechReady = true;
    }
  }
}

// ─── 语音选择 ───
function pickZhVoice() {
  if (!('speechSynthesis' in window)) return;
  const all = speechSynthesis.getVoices();
  if (!all.length) return;
  zhVoice = all.find(v => v.lang === 'zh-CN')
    || all.find(v => v.lang.startsWith('zh'))
    || all.find(v => v.lang.startsWith('cmn'))
    || null;
}

if ('speechSynthesis' in window) {
  pickZhVoice();
  speechSynthesis.onvoiceschanged = () => pickZhVoice();
  // iOS 有时不触发 onvoiceschanged，反复尝试
  setTimeout(pickZhVoice, 500);
  setTimeout(pickZhVoice, 1500);
  setTimeout(pickZhVoice, 3000);
  setTimeout(pickZhVoice, 5000);
}

// ─── Keepalive: 防止浏览器挂起 speechSynthesis ───
// Chrome/iOS 会在后台冻结 speechSynthesis，导致后续播报无声。
// 每 5 秒检查一次状态并恢复。
function startSpeechKeepalive() {
  if (speechKeepalive) return;
  speechKeepalive = setInterval(() => {
    if (!('speechSynthesis' in window)) return;
    // 如果引擎被暂停，立即恢复
    if (speechSynthesis.paused) {
      speechSynthesis.resume();
    }
    // 如果引擎"卡住"了（没在播放但 speechPlaying=true），检测恢复
    if (speechPlaying && !speechSynthesis.speaking && !speechSynthesis.pending) {
      // 引擎没有在说话也没有待说话，但标记为 playing → 说明 onend 没触发
      recoverStalledSpeech('keepalive检测到卡住');
    }
  }, 5000);
}

// ─── 前台恢复 ───
// 页面从后台/冻结恢复时，彻底重启语音引擎
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) recoverSpeechEngine('页面恢复前台');
});
document.addEventListener('resume', () => recoverSpeechEngine('页面resume'));
window.addEventListener('pageshow', () => recoverSpeechEngine('pageshow'));
window.addEventListener('focus', () => recoverSpeechEngine('focus'));

function recoverSpeechEngine(reason) {
  if (!('speechSynthesis' in window)) return;
  console.log(`[Speech] 恢复引擎: ${reason}`);
  // 重启 keepalive
  if (speechKeepalive) { clearInterval(speechKeepalive); speechKeepalive = null; }
  startSpeechKeepalive();
  // 确保引擎不在 paused 状态
  if (speechSynthesis.paused) {
    speechSynthesis.cancel(); // cancel 比 resume 更可靠
  }
  // 重新加载语音列表
  pickZhVoice();
  setTimeout(pickZhVoice, 500);
  // 如果有播报卡住，立即恢复
  if (speechPlaying) {
    recoverStalledSpeech(reason);
  }
}

// ─── 卡住恢复 ───
function recoverStalledSpeech(reason) {
  console.warn(`[Speech] 恢复卡住的播报: ${reason}`);
  if (speechWatchdog) { clearTimeout(speechWatchdog); speechWatchdog = null; }
  speechPlaying = false;
  speechFailCount++;
  if (speechFailCount >= SPEECH_MAX_FAIL) {
    hardResetSpeechEngine('连续失败' + speechFailCount + '次');
    return;
  }
  // 短延迟后继续队列
  setTimeout(() => processSpeechQueue(), 500);
}

// ─── 引擎硬重置 ───
// 当连续失败过多时，完全重建 speechSynthesis 状态
function hardResetSpeechEngine(reason) {
  if (speechEngineResetting) return;
  speechEngineResetting = true;
  console.warn(`[Speech] 硬重置引擎: ${reason}`);
  try { speechSynthesis.cancel(); } catch {}
  speechFailCount = 0;
  speechPlaying = false;
  if (speechWatchdog) { clearTimeout(speechWatchdog); speechWatchdog = null; }
  // 保存未播放的队列
  const remaining = [...speechQueue];
  speechQueue = [];
  // 短暂延迟后重新预热并恢复队列
  setTimeout(() => {
    speechEngineResetting = false;
    speechReady = false;
    speechQueue = remaining;
    pendingSpeech = [];
    initSpeechEngine();
  }, 1000);
}

// ─── 核心播放 ───
function doSpeak(text) {
  if (!('speechSynthesis' in window)) { speechPlaying = false; processSpeechQueue(); return; }

  // 先清理旧的 watchdog
  if (speechWatchdog) { clearTimeout(speechWatchdog); speechWatchdog = null; }

  try {
    // 确保引擎不卡在 paused
    if (speechSynthesis.paused) {
      speechSynthesis.cancel();
    }

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'zh-CN';
    utter.rate = 1.0;
    utter.pitch = 1.0;
    utter.volume = 1.0;
    if (zhVoice) utter.voice = zhVoice;

    let finished = false;
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      speechFailCount = 0; // 成功播放，重置失败计数
      if (speechWatchdog) { clearTimeout(speechWatchdog); speechWatchdog = null; }
      speechPlaying = false;
      setTimeout(() => processSpeechQueue(), 200);
    };

    utter.onend = () => finish('onend');
    utter.onerror = (e) => {
      console.warn('[Speech] error:', e.error);
      // 某些错误应该跳过这条继续（如 'canceled'）
      if (e.error === 'canceled' || e.error === 'interrupted') {
        finish('onerror:' + e.error);
      } else {
        speechFailCount++;
        finish('onerror:' + e.error);
      }
    };

    // ─── Watchdog: 如果 onend 不触发，用超时兜底 ───
    // 估算正常播放时长: 中文约 3-4 字/秒, rate=1.0
    // 加 2 倍缓冲作为安全上限, 最少 3 秒, 最多 15 秒
    const charCount = text.replace(/\s/g, '').length;
    const estDurationMs = Math.min(Math.max(charCount * 250, 3000), 12000);
    const watchdogMs = estDurationMs + 3000;

    speechWatchdog = setTimeout(() => {
      if (!finished) {
        console.warn(`[Speech] watchdog 超时 (${watchdogMs}ms), 强制回收`);
        // 尝试 cancel 后重新播放这条（可能是 iOS 15秒bug）
        try { speechSynthesis.cancel(); } catch {}
        finish('watchdog');
      }
    }, watchdogMs);

    speechSynthesis.speak(utter);

    // 额外保险：speak 后 500ms 检查是否真的开始说了
    setTimeout(() => {
      if (!finished && !speechSynthesis.speaking && !speechSynthesis.pending) {
        console.warn('[Speech] speak() 后未开始，尝试 resume');
        try { speechSynthesis.resume(); } catch {}
        // 再等 1 秒，如果还是没开始就回收
        setTimeout(() => {
          if (!finished && !speechSynthesis.speaking) {
            console.warn('[Speech] resume 无效，强制回收');
            try { speechSynthesis.cancel(); } catch {}
            finish('stuck-recovery');
          }
        }, 1000);
      }
    }, 500);

  } catch (e) {
    console.warn('[Speak] exception:', e);
    speechPlaying = false;
    speechFailCount++;
    if (speechFailCount >= SPEECH_MAX_FAIL) {
      hardResetSpeechEngine('exception');
    } else {
      setTimeout(() => processSpeechQueue(), 500);
    }
  }
}

// ─── 队列处理 ───
function processSpeechQueue() {
  if (speechEngineResetting) return; // 正在重置，等重置完
  if (speechPlaying) return;         // 正在播放中，等回调
  if (!speechQueue.length) return;   // 队列空了

  const next = speechQueue.shift();
  speechPlaying = true;
  doSpeak(next);
}

// ─── 外部接口 ───
function speakAlert(msg) {
  if (!voiceEnabled || !('speechSynthesis' in window)) return;
  const cleanMsg = msg.replace(/\$/g, ' 美元 ');
  if (!speechReady) {
    initSpeechEngine();
    pendingSpeech.push(cleanMsg);
    return;
  }
  speechQueue.push(cleanMsg);
  if (!speechPlaying) processSpeechQueue();
}

function flushPendingSpeech() {
  while (pendingSpeech.length) speechQueue.push(pendingSpeech.shift());
  if (!speechPlaying) processSpeechQueue();
}

// 币种名称映射：常见币种用中文名，其余逐字母拼读
const COIN_NAME_MAP = {
  BTC: '比特币', ETH: '以太坊', BNB: '币安币', SOL: 'Solana', XRP: '瑞波币',
  ADA: '艾达币', DOGE: '狗狗币', TRX: '波场', AVAX: '雪崩', DOT: '波卡',
  LINK: 'Chainlink', MATIC: 'Polygon', UNI: 'Uniswap', SHIB: 'Shib',
  LTC: '莱特币', BCH: '比特现金', ATOM: 'Cosmos', XLM: '恒星币',
  NEAR: 'Near', APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism',
  FIL: 'Filecoin', INJ: 'Injective', SUI: 'Sui', PEPE: 'Pepe',
  SEI: 'Sei', WLD: 'Worldcoin', TIA: 'Celestia', ORDI: 'ORDI',
  AAVE: 'Aave', MKR: 'Maker', SNX: 'Synthetix', COMP: 'Compound',
  CRV: 'Curve', LDO: 'Lido', STX: 'Stacks', IMX: 'Immutable',
  RNDR: 'Render', FET: 'Fetch', USDT: 'USDT', USDC: 'USDC',
};

// 把币种符号逐字母拼读（如 BTC → B T C）
function spellSymbol(sym) {
  return sym.split('').join(' ');
}

// 获取币种的播报名称
// spellSymbols=true → 全部逐字母拼读
// spellSymbols=false → 有中文名用中文，无则逐字母拼读
function getCoinSpeechName(sym) {
  if (spellSymbols) return spellSymbol(sym);
  if (COIN_NAME_MAP[sym]) return COIN_NAME_MAP[sym];
  if (/^[A-Z0-9]{2,8}$/.test(sym)) return spellSymbol(sym);
  return sym;
}

// ── Theme Toggle (Dark / Light) ──
function toggleTheme() {
  isLightTheme = !isLightTheme;
  localStorage.setItem('crypto_theme', isLightTheme ? 'light' : 'dark');
  applyTheme();
}

function applyTheme() {
  document.body.classList.toggle('light-theme', isLightTheme);
  document.getElementById('themeToggle').textContent = isLightTheme ? '☀️' : '🌙';
  document.getElementById('themeToggle').title = isLightTheme ? '切换到深色主题' : '切换到浅色主题';
  applyColorInvert();
}

// ── Color Inversion (Green/Red swap) ──
function toggleColorInvert() {
  colorInverted = !colorInverted;
  localStorage.setItem('crypto_color_invert', colorInverted ? '1' : '0');
  applyColorInvert();
}

function applyColorInvert() {
  const target = document.body;
  if (colorInverted) {
    target.style.setProperty('--green', isLightTheme ? '#d63858' : '#ff416c');
    target.style.setProperty('--red', isLightTheme ? '#00a86b' : '#00ff88');
    document.getElementById('colorInvertToggle').textContent = '🔃';
    document.getElementById('colorInvertToggle').title = '恢复默认涨跌颜色';
  } else {
    target.style.removeProperty('--green');
    target.style.removeProperty('--red');
    document.getElementById('colorInvertToggle').textContent = '🔄';
    document.getElementById('colorInvertToggle').title = '涨跌颜色反转';
  }
  // Re-render sparklines with correct colors
  coins.forEach(c => {
    const spEl = document.getElementById('sp-' + c.symbol);
    if (spEl) spEl.innerHTML = sparklineSvg(c.symbol);
  });
}

// ── Device Vibration + Haptic Feedback (mobile) ──
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function vibrateDevice(pattern) {
  if ('vibrate' in navigator && !isIOS) {
    try { navigator.vibrate(pattern); } catch {}
  }
  // iOS fallback: visual haptic — screen flash + badge pulse
  if (isIOS) {
    doVisualHaptic();
  }
}

// iOS has no vibration API, so we simulate "haptic feedback" with visual cues
function doVisualHaptic() {
  // Brief full-screen flash overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:9999;pointer-events:none;
    background:rgba(255,65,108,0.18);
    animation: hapticFlash 0.4s ease-out forwards;
  `;
  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), 500);

  // Pulse the alert badge bell icon
  const bell = document.querySelector('[onclick="openAlertModal()"]');
  if (bell) {
    bell.style.animation = 'none';
    void bell.offsetWidth;
    bell.style.animation = 'bellShake 0.5s ease-in-out 3';
    setTimeout(() => { bell.style.animation = ''; }, 1600);
  }
}

// ══ 跑马灯 + 爆闪预警效果 ══
// 全局开关（默认开启）
let screenAlertEnabled = localStorage.getItem('crypto_screen_alert') !== '0';
// 防止短时间内重复触发（冷却10秒）
let _lastScreenAlertTime = 0;
const SCREEN_ALERT_COOLDOWN = 10000;
// 跑马灯元素引用
let _marqueeEl = null;
let _marqueeTimer = null;

function toggleScreenAlert() {
  screenAlertEnabled = !screenAlertEnabled;
  localStorage.setItem('crypto_screen_alert', screenAlertEnabled ? '1' : '0');
  document.getElementById('screenAlertToggle').textContent = screenAlertEnabled ? '💡' : '⬛';
  if (screenAlertEnabled) {
    // 演示效果
    triggerScreenAlert('预警效果已开启', 'normal');
  }
}

// type: 'urgent' (强制预警/紧急) | 'normal' (价格预警)
function triggerScreenAlert(message, type) {
  if (!screenAlertEnabled) return;
  const now = Date.now();
  // 爆闪不冷却（每次都能闪），跑马灯有冷却
  const canMarquee = (now - _lastScreenAlertTime) > SCREEN_ALERT_COOLDOWN;
  if (!canMarquee) return; // 仅在冷却时跳过跑马灯
  _lastScreenAlertTime = now;

  const isUrgent = type === 'urgent';

  // 1) 跑马灯横幅
  _startMarquee(message, isUrgent);

  // 2) 爆闪
  _startStrobe(isUrgent);
}

function _startMarquee(msg, isUrgent) {
  // 清理旧的
  if (_marqueeEl) { _marqueeEl.remove(); _marqueeEl = null; }
  clearTimeout(_marqueeTimer);

  const overlay = document.createElement('div');
  overlay.className = 'alert-marquee-overlay';
  // 重复文本实现连续滚动
  const repeated = (isUrgent ? '🚨 ' : '🔔 ') + msg + '　　' + (isUrgent ? '🚨 ' : '🔔 ') + msg + '　　';
  overlay.innerHTML = `<span class="alert-marquee-text">${repeated + repeated + repeated}</span>`;
  document.body.appendChild(overlay);
  _marqueeEl = overlay;

  // 根据屏幕宽度自适应滚动速度：手机端更快
  const isMobile = window.innerWidth <= 480;
  const textSpan = overlay.querySelector('.alert-marquee-text');
  if (textSpan) {
    // 手机端: 5s滚动 | PC端: 8s
    const scrollDuration = isMobile ? '5s' : '8s';
    textSpan.style.animationDuration = scrollDuration;
  }

  // 持续时间：紧急更久
  const duration = isUrgent ? (isMobile ? 6000 : 8000) : (isMobile ? 4000 : 5000);
  _marqueeTimer = setTimeout(() => {
    if (_marqueeEl) {
      _marqueeEl.classList.add('marquee-exit');
      setTimeout(() => { if (_marqueeEl) { _marqueeEl.remove(); _marqueeEl = null; } }, 350);
    }
  }, duration);
}

function _startStrobe(isUrgent) {
  const overlay = document.createElement('div');
  const cls = isUrgent ? 'alert-strobe-overlay strobe-red' : 'alert-strobe-overlay strobe-orange';
  overlay.className = cls;
  document.body.appendChild(overlay);
  // 自动移除（12次 * 0.3s ≈ 1.8s）
  setTimeout(() => overlay.remove(), 2000);
}

// ── Enhanced Browser Notification + Vibration ──
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    // On iOS, don't auto-prompt — wait for user to explicitly enable via the notify modal
    // iOS shows a system dialog that blocks the page, which is bad UX if it pops up randomly
    if (!isIOS) {
      Notification.requestPermission();
    }
  }
  // Try registering SW for better notification support
  if ('serviceWorker' in navigator) {
    registerServiceWorker().catch(() => {});
  }
}

function sendBrowserNotification(title, body, tag) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const opts = {
      body: body,
      tag: tag || 'crypto-alert',
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🔔</text></svg>',
      badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">💰</text></svg>',
      requireInteraction: true,
      silent: false,
      timestamp: Date.now(),
      data: { url: '/' },
    };

    // Try Service Worker first (better iOS lock screen support — SW notifications persist)
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(reg => {
        reg.showNotification(title, opts);
      }).catch(() => {
        new Notification(title, opts);
      });
    } else if ('serviceWorker' in navigator) {
      // No controller yet — try registering SW then show notification
      registerServiceWorker().then(ok => {
        if (ok && navigator.serviceWorker.controller) {
          navigator.serviceWorker.ready.then(reg => {
            reg.showNotification(title, opts);
          });
        } else {
          new Notification(title, opts);
        }
      }).catch(() => {
        new Notification(title, opts);
      });
    } else {
      new Notification(title, opts);
    }

    // iOS visual haptic as extra feedback
    if (isIOS) doVisualHaptic();
  } catch (e) {
    console.warn('Notification failed:', e);
    try { new Notification(title, { body: body }); } catch {}
  }
}

// ── Alerts ──
function openAlertModal() {
  // 首次交互时初始化 AudioContext（浏览器要求用户手势）
  getAudioCtx();
  unlockAudio();
  const sel = document.getElementById('alertCoin');
  sel.innerHTML = coins.map(c => `<option value="${c.symbol}">${escapeHtml(c.symbol)} - ${escapeHtml(c.name)}</option>`).join('');
  renderAlertList();
  // Show iOS hint if on iOS
  document.getElementById('iosAlertHint').style.display = isIOS ? 'block' : 'none';
  document.getElementById('alertModalOverlay').classList.add('active');
}

function testAlertSound() {
  getAudioCtx();
  unlockAudio();
  // Play all three sound types sequentially so user can hear the difference
  playAlertSound();
  setTimeout(() => playNotifySound(), 500);
  setTimeout(() => playUrgentSound(), 1100);
  // iOS: also trigger visual haptic
  if (isIOS) doVisualHaptic();
  showToast('🔊 播放测试声音' + (isIOS ? '（iOS 无振动，已使用视觉反馈代替）' : ''));
}

function testVoiceAlert() {
  // 强制开启语音（用户主动点击，允许覆盖开关）
  const wasOff = !voiceEnabled;
  if (wasOff) {
    voiceEnabled = true;
    localStorage.setItem('crypto_voice', '1');
    document.getElementById('voiceToggle').textContent = '🗣️';
  }
  initSpeechEngine();
  // 直接在用户手势内调用 doSpeak（iOS 必须在 click 栈内调用）
  const testCoinName = getCoinSpeechName('BTC');
  doSpeak(`语音测试，${testCoinName}当前价格八万八千美元，预警已触发！`);
  if (isIOS) {
    showToast('🗣️ iOS 语音测试中…\n⚠️ iOS 自动预警时语音可能无法触发，建议开启通知渠道作为备用');
  } else {
    showToast('🗣️ 语音测试中…');
  }
}
function closeAlertModal() {
  document.getElementById('alertModalOverlay').classList.remove('active');
}
function addAlert() {
  const sym = document.getElementById('alertCoin').value;
  const dir = document.getElementById('alertDir').value;
  const price = parseFloat(document.getElementById('alertPrice').value);
  if (!sym || isNaN(price) || price <= 0) { showToast('请输入有效价格', 'error'); return; }

  // Read reminder interval
  let intervalVal = parseInt(document.getElementById('alertInterval').value) || 30;
  const intervalUnit = document.getElementById('alertIntervalUnit').value;
  if (intervalVal < 1) intervalVal = 1;
  const cooldownMs = intervalUnit === 'm' ? intervalVal * 60000 : intervalVal * 1000;

  if (alerts.some(a => a.symbol === sym && a.dir === dir && a.price === price)) { showToast('预警已存在', 'error'); return; }
  alerts.push({ symbol: sym, dir, price, lastNotified: 0, cooldownMs });
  saveAlerts();
  document.getElementById('alertPrice').value = '';
  document.getElementById('alertInterval').value = '30';
  document.getElementById('alertIntervalUnit').value = 's';
  renderAlertList();
  render(true);
  playNotifySound();
  const intervalText = cooldownMs >= 60000 ? (cooldownMs / 60000) + '分钟' : (cooldownMs / 1000) + '秒';
  showToast(`已添加 ${sym} ${dir === 'above' ? '>' : '<'} ${fmtRaw(price)} 预警（间隔 ${intervalText}）`);
}
function removeAlert(idx) {
  alerts.splice(idx, 1);
  saveAlerts();
  renderAlertList();
  render(true);
}
function renderAlertList() {
  const wrap = document.getElementById('alertListWrap');
  const countEl = document.getElementById('alertCount');
  if (countEl) countEl.textContent = alerts.length ? `${alerts.length} 条` : '空';
  if (!alerts.length) { wrap.innerHTML = '<div class="alert-empty">暂无预警，点击下方 ➕ 添加</div>'; return; }
  wrap.innerHTML = alerts.map((a, i) => {
    const dirIcon = a.dir === 'above' ? '📈' : '📉';
    const dirText = a.dir === 'above' ? '高于' : '低于';
    const cd = a.cooldownMs || ALERT_COOLDOWN_DEFAULT_MS;
    const intervalText = cd >= 60000 ? (cd / 60000) + '分钟' : (cd / 1000) + '秒';
    return `<div class="alert-item">
      <div class="alert-item-left">
        <span class="alert-item-icon">${dirIcon}</span>
        <div class="alert-item-info">
          <span class="alert-sym">${a.symbol}</span>
          <span class="alert-cond">${dirText} <strong>${fmtRaw(a.price)}</strong> USD</span>
        </div>
      </div>
      <div class="alert-item-right">
        <span class="alert-interval-tag">⏱ ${intervalText}</span>
        <button class="alert-del" onclick="removeAlert(${i})" title="删除">✕</button>
      </div>
    </div>`;
  }).join('');
}

const ALERT_COOLDOWN_DEFAULT_MS = 5000; // 默认 5 秒冷却

function exportAlerts() {
  if (!alerts.length) { showToast('暂无预警数据可导出', 'error'); return; }
  const data = {
    version: 1,
    type: 'alerts',
    alerts: alerts.map(a => ({
      symbol: a.symbol,
      dir: a.dir,
      price: a.price,
      intervalMs: a.intervalMs || 300000,
    })),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `crypto-alerts-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('预警数据已导出');
}

function importAlerts(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      let importedAlerts = null;
      if (data.type === 'alerts' && Array.isArray(data.alerts)) {
        importedAlerts = data.alerts;
      } else if (Array.isArray(data.alerts)) {
        // 兼容全局导出文件中也含有 alerts 字段的情况
        importedAlerts = data.alerts;
      } else {
        showToast('导入失败：文件中未找到预警数据', 'error'); return;
      }
      if (!importedAlerts.length) { showToast('导入失败：预警列表为空', 'error'); return; }
      const existingKeys = new Set(alerts.map(a => `${a.symbol}_${a.dir}_${a.price}`));
      let added = 0, skipped = 0;
      importedAlerts.forEach(a => {
        const key = `${(a.symbol||'').toUpperCase()}_${a.dir}_${a.price}`;
        if (existingKeys.has(key)) { skipped++; return; }
        existingKeys.add(key);
        alerts.push({
          symbol: (a.symbol || '').toUpperCase(),
          dir: a.dir,
          price: a.price,
          intervalMs: a.intervalMs || 300000,
          lastNotified: 0,
        });
        added++;
      });
      saveAlerts();
      renderAlertList();
      updateTabBadge();
      if (skipped > 0) showToast(`预警导入完成：新增 ${added} 条，跳过 ${skipped} 条已存在的预警`);
      else if (added > 0) showToast(`预警导入完成：新增 ${added} 条预警`);
      else showToast('无新增预警（全部已存在）', 'error');
    } catch { showToast('导入失败：文件格式无效', 'error'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function applyAlertPreset(val) {
  if (!val) return;
  const m = val.match(/^(\d+)(s|m)$/);
  if (!m) return;
  document.getElementById('alertInterval').value = m[1];
  document.getElementById('alertIntervalUnit').value = m[2];
  document.getElementById('alertIntervalPreset').value = '';
}

function checkAlerts(sym, currentPrice) {
  const now = Date.now();
  let hasUrgent = false;
  let hasAlert = false;

  alerts.forEach(a => {
    if (a.symbol !== sym) return;
    const hit = (a.dir === 'above' && currentPrice >= a.price) ||
                (a.dir === 'below' && currentPrice <= a.price);
    if (hit) {
      // Use per-alert cooldown (fallback to default)
      const cooldown = a.cooldownMs || ALERT_COOLDOWN_DEFAULT_MS;
      if (now - (a.lastNotified || 0) < cooldown) return;

      a.lastNotified = now;
      saveAlerts();
      hasAlert = true;

      const msg = `${sym} 当前 $${fmtRaw(currentPrice)} 已${a.dir === 'above' ? '突破' : '跌破'} ${fmtRaw(a.price)}!`;

      // 首次触发用紧急音，后续持续触发用普通预警音
      if (!a._everTriggered) {
        a._everTriggered = true;
        hasUrgent = true;
      }

      showToast(msg, 'alert');

      // 语音播报（单独构造更口语化的文案，币种逐字母拼读）
      const coinName = getCoinSpeechName(sym);
      const voiceMsg = `${coinName}预警！当前价格${fmtRaw(currentPrice)}美元，已${a.dir === 'above' ? '涨破' : '跌穿'}${fmtRaw(a.price)}美元！`;
      speakAlert(voiceMsg);

      // External notifications (WeChat / Email)
      sendExternalNotification(
        `🔔 Crypto Alert — ${sym}`,
        `${msg}\n\n当前价格: $${fmtRaw(currentPrice)}\n预警条件: ${a.dir === 'above' ? '高于' : '低于'} $${fmtRaw(a.price)}\n触发时间: ${new Date().toLocaleString('zh-CN')}`
      );

      // 浏览器弹窗通知
      sendBrowserNotification('🔔 Crypto Alert — ' + sym, msg, 'crypto-' + sym + '-' + a.dir);

      // 手机震动（短-长-短 紧急模式）
      vibrateDevice([100, 50, 200, 50, 100]);

      // 屏幕跑马灯 + 爆闪
      triggerScreenAlert(msg, hasUrgent ? 'urgent' : 'normal');
    } else {
      // 价格回到正常范围，重置冷却和触发标记，下次突破会立即重新通知
      a._everTriggered = false;
      if (a.lastNotified) {
        a.lastNotified = 0;
        saveAlerts();
      }
    }
  });

  if (hasUrgent) {
    playUrgentSound();
  } else if (hasAlert) {
    playAlertSound();
  }
}

// ══════════════════════════════════════════════════════════════
// ── 强制预警 (Force Alert) ──
// 监控币种在指定时间窗口内的跌幅，超过阈值时触发语音预警
// ══════════════════════════════════════════════════════════════

// 记录价格快照（每次 applyCoinData 调用时记录，实时跟随主列表价格更新）
// WebSocket 推送的每次价格变化都会记录，不漏采样
function recordForceSnapshot(sym, price) {
  // 只记录有强制预警的币种，避免无意义存储
  if (!forceAlerts.some(f => f.enabled && f.symbol === sym)) return;
  const now = Date.now();
  if (!forceAlertSnapshots[sym]) forceAlertSnapshots[sym] = [];
  const snaps = forceAlertSnapshots[sym];
  // 节流：价格没变就不记录，避免重复数据
  if (snaps.length && snaps[snaps.length - 1].p === price) return;
  snaps.push({ p: price, t: now });
  // 清理过期快照
  const cutoff = now - FORCE_SNAPSHOT_MAX_AGE_MS;
  while (snaps.length && snaps[0].t < cutoff) snaps.shift();
  // 持久化（节流写入）
  saveForceSnapshotsThrottled();
}

// 检查某币种在指定窗口内的最大跌幅
function calcWindowDrop(sym, windowMinutes) {
  const snaps = forceAlertSnapshots[sym];
  if (!snaps || snaps.length < 2) return { drop: 0, fromPrice: 0, toPrice: 0, windowActual: 0 };
  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;
  const cutoff = now - windowMs;
  // 找到窗口内最早的快照
  const inWindow = snaps.filter(s => s.t >= cutoff);
  if (inWindow.length < 2) return { drop: 0, fromPrice: 0, toPrice: 0, windowActual: 0 };
  const peakPrice = Math.max(...inWindow.map(s => s.p));
  const currentPrice = inWindow[inWindow.length - 1].p;
  const dropPct = peakPrice > 0 ? ((peakPrice - currentPrice) / peakPrice * 100) : 0;
  const windowActual = (now - inWindow[0].t) / 60000; // 实际窗口分钟数
  return { drop: dropPct, fromPrice: peakPrice, toPrice: currentPrice, windowActual };
}

// 核心：检查所有强制预警
function checkForceAlerts() {
  const now = Date.now();
  forceAlerts.forEach(fa => {
    if (!fa.enabled) return;
    // 冷却检查
    const cooldown = fa.cooldownMs || 300000; // 默认5分钟冷却
    if (now - (fa.lastTriggered || 0) < cooldown) return;
    const result = calcWindowDrop(fa.symbol, fa.windowMinutes);
    if (result.drop >= fa.dropPercent && result.fromPrice > 0) {
      // 🚨 触发强制预警！
      fa.lastTriggered = now;
      saveForceAlerts();
      const coinName = getCoinSpeechName(fa.symbol);
      const dropStr = result.drop.toFixed(2);
      // Toast 提醒
      showToast(`🚨 ${fa.symbol} ${fa.windowMinutes}分钟内跌幅 ${dropStr}%！($${fmtRaw(result.fromPrice)} → $${fmtRaw(result.toPrice)})`, 'alert');
      // 语音紧急预警（强制开启，不受 voiceEnabled 限制）
      const urgentMsg = `紧急预警！${coinName}在${fa.windowMinutes}分钟内暴跌${dropStr}个百分点！从${fmtRaw(result.fromPrice)}美元跌至${fmtRaw(result.toPrice)}美元！请注意风险！`;
      forceSpeakAlert(urgentMsg);
      // 紧急音效
      playUrgentSound();
      // 震动（更强烈的模式）
      vibrateDevice([200, 100, 200, 100, 200, 100, 500]);
      // 屏幕跑马灯 + 爆闪（强制预警=紧急模式）
      triggerScreenAlert(`🚨 ${fa.symbol} ${fa.windowMinutes}min跌${dropStr}%！`, 'urgent');
      // 外部通知
      sendExternalNotification(
        `🚨 强制预警 — ${fa.symbol}`,
        `${fa.symbol} 在 ${fa.windowMinutes} 分钟内跌幅 ${dropStr}%！\n窗口高点: $${fmtRaw(result.fromPrice)}\n当前价格: $${fmtRaw(result.toPrice)}\n触发时间: ${new Date().toLocaleString('zh-CN')}`
      );
      // 浏览器通知
      sendBrowserNotification('🚨 强制预警 — ' + fa.symbol, `${fa.windowMinutes}min内跌${dropStr}%: $${fmtRaw(result.fromPrice)}→$${fmtRaw(result.toPrice)}`, 'force-' + fa.symbol);
    }
  });
}

// 强制语音播报（不受 voiceEnabled 开关限制，用于紧急预警）
function forceSpeakAlert(msg) {
  if (!('speechSynthesis' in window)) return;
  const cleanMsg = msg.replace(/\$/g, ' 美元 ');
  // 即使 voiceEnabled=false 也播报（紧急情况）
  const wasVoiceEnabled = voiceEnabled;
  voiceEnabled = true;
  if (!speechReady) {
    initSpeechEngine();
    pendingSpeech.push(cleanMsg);
  } else {
    speechQueue.push(cleanMsg);
    if (!speechPlaying) processSpeechQueue();
  }
  // 恢复原状态（不改变用户设置）
  voiceEnabled = wasVoiceEnabled;
}

// 启动/停止统一强制预警调度器（单定时器驱动所有检测）
function syncForceMonitors() {
  const hasEnabled = forceAlerts.some(f => f.enabled);
  if (hasEnabled && !forceMonitorTimer) {
    // 初始化快照：给所有需要监控的币种一个初始快照
    forceAlerts.filter(f => f.enabled).forEach(fa => {
      if (!forceAlertSnapshots[fa.symbol] || !forceAlertSnapshots[fa.symbol].length) {
        const ph = priceHistory[fa.symbol];
        if (ph && ph.length) {
          forceAlertSnapshots[fa.symbol] = [{ p: ph[ph.length - 1].p, t: Date.now() }];
        }
      }
    });
    // 只启动一个定时器
    forceMonitorTimer = setInterval(() => {
      checkForceAlerts();
    }, FORCE_SNAPSHOT_INTERVAL_MS);
  } else if (!hasEnabled && forceMonitorTimer) {
    clearInterval(forceMonitorTimer);
    forceMonitorTimer = null;
  }
}

// ── Toast ──
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'alert' ? ' alert-toast' : '');
  const title = type === 'alert' ? '⚠️ 价格预警触发' : type === 'error' ? '❌ 错误' : '✅ 提示';
  el.innerHTML = `<div class="toast-title">${title}</div><div class="toast-body">${escapeHtml(String(msg))}</div>`;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('toast-exit'); setTimeout(() => el.remove(), 300); }, 4000);
}

// ── 刷新按钮统一反馈机制 ──
// 点击：toast 提示 + 按钮进入 refreshing 状态
// 完成：toast 更新为"已刷新"+ 数据条数，按钮恢复
function refreshTrending(btn) {
  btn.classList.add('refreshing');
  // Match news refresh button style: replace text with spinning icon
  const origText = btn.textContent;
  btn.innerHTML = '<span class="refresh-icon" style="display:inline-block;animation:spin 0.8s linear infinite">⏳</span>';
  showToast('🔄 正在刷新热搜数据…');
  // Force refresh: reset cooldown
  _lastTrendingFetch = 0;
  fetchTrending(true).then(() => {
    btn.classList.remove('refreshing');
    btn.textContent = origText;
    if (trendingCoins.length) {
      showToast(`✅ 热搜已刷新，共 ${trendingCoins.length} 个币种`);
    } else {
      showToast('热搜刷新完成，暂无数据', 'error');
    }
  }).catch(() => {
    btn.classList.remove('refreshing');
    btn.textContent = origText;
    showToast('热搜刷新失败，请稍后重试', 'error');
  });
}

function refreshNews(btn) {
  btn.classList.add('refreshing');
  const icon = btn.querySelector('.refresh-icon');
  if (icon) icon.textContent = '⏳';
  showToast('🔄 正在刷新新闻…');
  // 强制刷新：重置冷却时间
  _lastNewsFetch = 0;
  fetchNews().then(() => {
    btn.classList.remove('refreshing');
    if (icon) icon.textContent = '🔄';
    const count = newsData.length;
    showToast(`✅ 新闻已刷新，共 ${count} 条`);
  }).catch(() => {
    btn.classList.remove('refreshing');
    if (icon) icon.textContent = '🔄';
    showToast('新闻刷新失败，请稍后重试', 'error');
  });
}

function refreshUnlocks(btn) {
  btn.classList.add('refreshing');
  const icon = btn.querySelector('.refresh-icon');
  if (icon) icon.textContent = '⏳';
  showToast('🔄 正在刷新解锁数据…');
  // 强制刷新：重置冷却时间
  _lastUnlockFetch = 0;
  fetchUnlocks().then(() => {
    btn.classList.remove('refreshing');
    if (icon) icon.textContent = '🔄';
    const count = unlockData.length;
    showToast(`✅ 解锁数据已刷新，共 ${count} 个事件`);
  }).catch(() => {
    btn.classList.remove('refreshing');
    if (icon) icon.textContent = '🔄';
    showToast('解锁数据刷新失败，请稍后重试', 'error');
  });
}

// ── Export / Import ──
function exportData() {
  const data = {
    version: 4,
    coins,
    alerts,
    portfolio,
    coinApiMap,
    activeApi,
    refreshSec,
    currency,
    soundEnabled,
    spellSymbols,
    isLightTheme,
    colorInverted,
    notifyConfig,
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `crypto-monitor-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('数据已导出');
}
function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.coins) {
        // Deduplicate imported coins and validate structure, merge with existing
        const existingSyms = new Set(coins.map(c => c.symbol.toUpperCase()));
        const seen = new Set();
        let added = 0, skipped = 0;
        data.coins.forEach(c => {
          const sym = (c.symbol || '').toUpperCase();
          if (!sym || seen.has(sym)) return;
          seen.add(sym);
          if (existingSyms.has(sym)) { skipped++; return; }
          coins.push({ symbol: sym, name: c.name || sym });
          existingSyms.add(sym);
          added++;
        });
        saveCoins();
        if (skipped > 0) showToast(`导入完成：新增 ${added} 个，跳过 ${skipped} 个已存在的币种`);
        else if (added > 0) showToast(`导入完成：新增 ${added} 个币种`);
      }
      if (data.alerts) {
        alerts = data.alerts.map(a => ({ ...a, lastNotified: a.lastNotified || 0 }));
        saveAlerts();
      }
      if (data.portfolio) { portfolio = data.portfolio; savePortfolio(); }
      if (data.soundEnabled != null) { soundEnabled = data.soundEnabled; localStorage.setItem('crypto_sound', soundEnabled ? '1' : '0'); document.getElementById('soundToggle').textContent = soundEnabled ? '🔊' : '🔇'; }
      if (data.spellSymbols != null) { spellSymbols = data.spellSymbols; localStorage.setItem('crypto_spell', spellSymbols ? '1' : '0'); document.getElementById('spellToggle').textContent = spellSymbols ? '🔤' : '🀄'; }
      if (data.notifyConfig) { notifyConfig = data.notifyConfig; localStorage.setItem('crypto_notify', JSON.stringify(notifyConfig)); }
      if (data.coinApiMap) { coinApiMap = data.coinApiMap; saveCoinApiMap(); }
      if (data.activeApi != null) { activeApi = data.activeApi; localStorage.setItem('crypto_api', activeApi); }
      if (data.refreshSec) { refreshSec = data.refreshSec; localStorage.setItem('crypto_refresh', refreshSec); }
      if (data.currency) { currency = data.currency; localStorage.setItem('crypto_currency', currency); document.getElementById('currencySelect').value = currency; }
      if (data.isLightTheme != null) { isLightTheme = data.isLightTheme; localStorage.setItem('crypto_theme', isLightTheme ? 'light' : 'dark'); applyTheme(); }
      if (data.colorInverted != null) { colorInverted = data.colorInverted; localStorage.setItem('crypto_color_invert', colorInverted ? '1' : '0'); applyColorInvert(); }
      priceHistory = {};
      prevPrices = {};
      initSelects();
      render(true);
      wsResync();
      fetchPrices();
      showToast('数据导入成功！');
    } catch { showToast('导入失败：文件格式无效', 'error'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ── Trending ──
let trendingCoins = [];
let _fetchingTrending = false;
let _lastTrendingFetch = 0;
const TRENDING_COOLDOWN = 300000; // 5分钟冷却（热搜数据变化慢，减少 CoinGecko 请求频率）

// 初始化时先从缓存加载并渲染，确保切换页面回来数据不丢失
(function initTrendingFromCache() {
  try {
    const cached = JSON.parse(localStorage.getItem('crypto_trending_cache') || 'null');
    if (cached?.data?.length) {
      trendingCoins = cached.data;
    }
  } catch {}
})();
// DOM 就绪后立即渲染缓存数据（不等 API）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { if (trendingCoins.length) renderTrending(); });
} else {
  if (trendingCoins.length) renderTrending();
}

async function fetchTrending(force) {
  const now = Date.now();
  if (_fetchingTrending) return;
  if (!force && (now - _lastTrendingFetch < TRENDING_COOLDOWN)) {
    console.log(`[Trending] 跳过请求（距上次 ${(now - _lastTrendingFetch)/1000|0}s，冷却 ${TRENDING_COOLDOWN/1000}s）`);
    // 冷却中但有数据：确保 UI 显示正确
    if (trendingCoins.length) renderTrending();
    return;
  }
  _lastTrendingFetch = now;
  _fetchingTrending = true;

  const groupsEl = document.getElementById('trendingGroups');

  // 有缓存数据时不显示 loading，直接后台刷新（避免闪烁）
  const hasCachedData = trendingCoins.length > 0;
  if (!hasCachedData) {
    groupsEl.innerHTML = '<div class="trending-loading"><span class="spinner"></span>加载热搜榜…</div>';
    document.getElementById('trendingCount').textContent = '--';
  }

  try {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const seen = new Set();
    const newCoins = [];

    // CoinGecko requests via rate-limited queue (cgThrottle handles spacing)
    let trendingData = null, topData = null, gainersData = null;

    try {
      trendingData = await cgFetch('https://api.coingecko.com/api/v3/search/trending', 10000);
    } catch {}

    try {
      topData = await cgFetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1', 10000);
    } catch {}

    try {
      gainersData = await cgFetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=10&page=1', 10000);
    } catch {}

    // 解析热搜
    if (trendingData?.coins) {
      trendingData.coins.forEach((item, i) => {
        const c = item.item;
        const sym = (c.symbol || '').toUpperCase();
        if (!sym || seen.has(sym)) return;
        seen.add(sym);
        newCoins.push({
          symbol: sym,
          name: c.name || '',
          rank: c.market_cap_rank || (i + 1),
          change24h: c.data?.price_change_percentage_24h?.usd ?? null,
          group: 'hot',
        });
      });
    }

    // 解析市值头部
    if (Array.isArray(topData)) {
      topData.forEach(c => {
        const sym = (c.symbol || '').toUpperCase();
        if (!sym || seen.has(sym)) return;
        seen.add(sym);
        newCoins.push({
          symbol: sym, name: c.name || '',
          rank: c.market_cap_rank || null,
          change24h: c.price_change_percentage_24h ?? null,
          group: 'top',
        });
      });
    }

    // 解析涨幅榜
    if (Array.isArray(gainersData)) {
      gainersData.forEach(c => {
        const sym = (c.symbol || '').toUpperCase();
        if (!sym || seen.has(sym)) return;
        seen.add(sym);
        newCoins.push({
          symbol: sym, name: c.name || '',
          rank: c.market_cap_rank || null,
          change24h: c.price_change_percentage_24h ?? null,
          group: 'gainers',
        });
      });
    }

    if (newCoins.length) {
      // 有新数据：更新 trendingCoins 并缓存
      trendingCoins = newCoins;
      localStorage.setItem('crypto_trending_cache', JSON.stringify({
        data: trendingCoins,
        ts: Date.now(),
      }));
      document.getElementById('trendingCount').textContent = trendingCoins.length + ' 个';
      renderTrending();
    } else if (hasCachedData) {
      // 请求失败但有旧缓存：保留旧数据，不刷 UI
      console.log('[Trending] API 无数据，保留缓存显示');
    } else {
      // 完全无数据：尝试从 localStorage 加载
      try {
        const cached = JSON.parse(localStorage.getItem('crypto_trending_cache') || 'null');
        if (cached?.data?.length) {
          trendingCoins = cached.data;
          const ageMin = Math.round((Date.now() - cached.ts) / 60000);
          document.getElementById('trendingCount').textContent = trendingCoins.length + ' 个（缓存' + (ageMin < 1 ? '<1' : ageMin) + '分钟前）';
          renderTrending();
        } else {
          groupsEl.innerHTML = '<div class="trending-err">⚠️ 热搜加载失败，请稍后重试</div>';
        }
      } catch {
        groupsEl.innerHTML = '<div class="trending-err">⚠️ 热搜加载失败，请稍后重试</div>';
      }
    }
  } catch (e) {
    // 外层异常：有缓存就保留，不刷 UI
    if (!hasCachedData) {
      groupsEl.innerHTML = '<div class="trending-err">⚠️ 热搜加载失败，请稍后重试</div>';
    }
  } finally {
    _fetchingTrending = false;
  }
}

async function fetchJson(url, ms) {
  try { return await fetchWithCors(url, ms); }
  catch {
    // fallback direct
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(res.status);
      return res.json();
    } catch (err) {
      clearTimeout(t);
      throw err;
    }
  }
}

function renderTrending() {
  const groupsEl = document.getElementById('trendingGroups');
  if (!trendingCoins.length) { groupsEl.innerHTML = '<div class="trending-err">暂无热搜数据</div>'; return; }

  const groups = {
    hot: { label: '🔥 实时热搜', items: [] },
    top: { label: '💎 市值头部', items: [] },
    gainers: { label: '📈 24h 涨幅榜', items: [] },
  };
  trendingCoins.forEach(tc => { if (groups[tc.group]) groups[tc.group].items.push(tc); });

  let html = '';
  for (const [key, g] of Object.entries(groups)) {
    if (!g.items.length) continue;
    html += `<div class="trending-group ${key}">
      <div class="trending-group-label">${g.label}</div>
      <div class="trending-tags">`;
    g.items.forEach(tc => {
      const alreadyAdded = coins.some(c => c.symbol === tc.symbol);
      const cls = alreadyAdded ? 'trending-tag added' : 'trending-tag';
      let changeHtml = '';
      if (tc.change24h != null) {
        const sign = tc.change24h >= 0 ? '+' : '';
        const dir = tc.change24h >= 0 ? 'up' : 'down';
        changeHtml = `<span class="tag-change ${dir}">${sign}${tc.change24h.toFixed(1)}%</span>`;
      }
      const rankHtml = tc.rank ? `<span class="tag-rank">#${tc.rank}</span>` : '';
      const nameShort = tc.name.length > 10 ? tc.name.slice(0, 10) + '…' : tc.name;
      const actionIcon = alreadyAdded
        ? `<span class="tag-action remove-icon" title="移除">✕</span>`
        : `<span class="tag-action add-icon" title="添加">＋</span>`;

      html += `<span class="${cls}" data-tsym="${escapeAttr(tc.symbol)}" data-tname="${escapeAttr(tc.name)}" title="${escapeAttr(tc.name)}" onclick="toggleTrendingFromEl(this)">
        ${rankHtml}
        <span class="tag-sym">${escapeHtml(tc.symbol)}</span>
        <span class="tag-name">${escapeHtml(nameShort)}</span>
        ${changeHtml}
        ${actionIcon}
      </span>`;
    });
    html += '</div></div>';
  }
  groupsEl.innerHTML = html;
}

// ── Coin Descriptions ──
var COIN_DESCRIPTIONS = {
  'BTC': '比特币，首个去中心化加密货币，由中本聪于2009年创建。采用工作量证明(PoW)共识机制，总量2100万枚，被誉为"数字黄金"，是整个加密市场的风向标。',
  'ETH': '以太坊，Vitalik Buterin于2015年推出的智能合约平台。支持DeFi、NFT、DAO等应用生态，2022年完成从PoW到PoS的合并升级，是最大的可编程区块链。',
  'BNB': '币安币，币安交易所原生代币。最初基于以太坊ERC-20，后迁移至BNB Chain。用于交易手续费折扣、Launchpad参与及链上Gas费支付。',
  'SOL': 'Solana，高性能Layer 1公链，以高TPS和低交易费著称。采用PoH(历史证明)+PoS混合共识，在DeFi和NFT领域快速发展。',
  'XRP': '瑞波币，Ripple Labs开发，专注于跨境支付和银行间结算。交易速度快、费用低，与全球多家金融机构建立合作关系。',
  'ADA': 'Cardano，由以太坊联合创始人Charles Hoskinson创建。采用学术研究驱动的Ouroboros PoS协议，强调安全性和可扩展性。',
  'DOGE': '狗狗币，2013年作为玩笑币诞生，基于Litecoin分叉。因Elon Musk力挺和社区文化走红，从Meme币逐渐获得实际支付场景。',
  'AVAX': 'Avalanche，主打高吞吐量和快速确认的Layer 1平台。支持子网(Subnet)架构，兼容EVM，在DeFi和企业级应用中表现活跃。',
  'DOT': 'Polkadot，Gavin Wood(以太坊联合创始人)创建的多链互操作协议。通过中继链和平行链架构实现跨链通信和共享安全。',
  'MATIC': 'Polygon，以太坊的Layer 2扩容方案。提供侧链和ZK Rollup解决方案，大幅降低Gas费用，是以太坊生态最重要的扩容网络之一。',
  'LINK': 'Chainlink，去中心化预言机网络。为智能合约提供链下数据(价格、天气、体育赛事等)，是DeFi基础设施的关键组件。',
  'UNI': 'Uniswap，以太坊上最大的去中心化交易所(DEX)。采用自动做市商(AMM)模式，UNI是其治理代币，持有者可参与协议决策。',
  'SHIB': 'Shiba Inu，自称"狗狗币杀手"的Meme代币。生态包含ShibaSwap DEX、LEASH和BONE代币，拥有活跃的社区驱动生态。',
  'LTC': '莱特币，2011年Charlie Lee基于比特币分叉创建。出块更快(2.5分钟)、总量8400万枚，被称为"数字白银"。',
  'TRX': '波场TRON，孙宇晨创建的区块链平台。专注于去中心化内容娱乐和稳定币(USDT-TRC20)转账，链上USDT流通量领先。',
  'ATOM': 'Cosmos，"区块链互联网"。通过IBC协议实现不同区块链间的互操作，采用Tendermint共识，生态包含众多独立区块链。',
  'XLM': '恒星币，Jed McCaleb(Ripple联合创始人)创建。专注于普惠金融和跨境汇款，与IBM等企业合作推进银行间结算。',
  'FIL': 'Filecoin，去中心化存储网络。基于IPFS协议，激励用户提供存储空间，旨在构建去中心化的数据存储市场。',
  'NEAR': 'NEAR Protocol，主打用户体验的Layer 1公链。采用分片技术(Nightshade)实现扩展，支持账户抽象，降低用户使用门槛。',
  'APT': 'Aptos，由前Meta(Diem)工程师创建的Layer 1公链。使用Move编程语言，强调安全性和并行执行，实现高吞吐量。',
  'OP': 'Optimism，以太坊Layer 2扩容方案，采用Optimistic Rollup技术。OP代币用于治理，是Superchain生态的核心。',
  'ARB': 'Arbitrum，以太坊上TVL最高的Layer 2网络。采用Optimistic Rollup技术，提供更低的Gas费和更快的确认速度。',
  'SUI': 'Sui，由前Meta团队(Mysten Labs)开发的Layer 1公链。使用Move语言，支持对象并行处理，面向游戏和社交应用。',
  'PEPE': 'Pepe the Frog Meme代币，2023年爆红的纯社区驱动Meme币。无预挖、无团队份额，完全由社区共识推动。',
  'WIF': 'dogwifhat，Solana生态的Meme代币，以"戴帽子的柴犬"形象走红。2024年快速崛起，成为Solana上最具代表性的Meme币之一。',
  'TON': 'The Open Network，由Telegram团队最初设计的区块链。后由社区接管开发，与Telegram深度整合，拥有庞大的潜在用户基础。',
  'RENDER': 'Render Network，去中心化GPU渲染网络。连接需要渲染的创作者和闲置GPU提供者，应用于影视、游戏和AI计算。',
  'STX': 'Stacks，比特币智能合约层。通过Proof of Transfer(PoX)与比特币锚定，为比特币生态带来DeFi和NFT等可编程性。',
  'FET': 'Fetch.ai，AI与区块链融合项目。构建自主经济代理(AEA)框架，用于优化交通、能源和供应链等场景。现为ASI联盟成员。',
  'INJ': 'Injective，去中心化衍生品交易平台Layer 1。支持永续合约、期权和现货交易，采用Tendermint共识，完全去中心化订单簿。',
  'MKR': 'MakerDAO治理代币。Maker是以太坊上最早的DeFi协议之一，发行超额抵押稳定币DAI，MKR持有者参与协议治理。',
  'AAVE': 'Aave，领先的去中心化借贷协议。支持多种资产的存款和借款，首创闪电贷(Flash Loan)功能，是DeFi蓝筹项目。',
  'CRV': 'Curve Finance治理代币。Curve是稳定币和同类资产交换的DEX，以低滑点和低费用著称，是稳定币交易的核心基础设施。',
  'WLFI': 'World Liberty Financial，与特朗普家族相关的DeFi项目。旨在推动加密货币采用和去中心化金融服务的普及。',
  'TRUMP': 'Official Trump Meme代币，Solana上的政治主题Meme币。以美国前总统特朗普为主题，由社区驱动的投机性代币。',
  'GT': 'Gate.io交易所平台代币。持有GT可享受交易手续费折扣、参与Startup首发项目投票及空投等权益。',
  'BGB': 'Bitget交易所平台代币。用于手续费抵扣、Launchpad参与和VIP等级提升，是Bitget生态的核心权益凭证。',
  'KCS': 'KuCoin交易所平台代币。持有KCS可获交易手续费折扣和每日分红，是KuCoin生态的激励和治理代币。',
  'LEO': 'UNUS SED LEO，Bitfinex交易所平台代币。用于降低交易费用，iFinex公司承诺用收入回购销毁LEO代币。',
  'CRO': 'Cronos，Crypto.com生态的原生代币。驱动Crypto.org Chain和Cronos EVM链，用于支付、DeFi和NFT等场景。',
  'OKB': 'OKX交易所平台代币。用于手续费折扣、Jumpstart参与和OKX Chain生态，是OKX平台的核心权益代币。',
  'HT': 'Huobi Token(HTX)，火币(HTX)交易所平台代币。用于交易费折扣、投票上币和生态治理。',
};

function getCoinDesc(sym) {
  return COIN_DESCRIPTIONS[sym] || '';
}

// ── Coin Hover Card ──
(function() {
  var card = document.createElement('div');
  card.className = 'coin-hover-card';
  document.body.appendChild(card);
  var hideT = null;
  var curSym = null;
  var hoverEl = null;  // current element being hovered (.coin-info or .trending-tag)

  function hashColor(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return '#' + ((h >>> 0) & 0xFFFFFF).toString(16).padStart(6, '0');
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function show(sym, name, rank, chg, el) {
    clearTimeout(hideT);
    if (sym === curSym && card.classList.contains('visible')) return;
    curSym = sym;
    hoverEl = el;
    var ph = priceHistory[sym];
    var last = ph && ph.length ? ph[ph.length - 1] : null;
    var col = hashColor(sym);
    var ini = sym.length > 4 ? sym.slice(0, 3) : sym;
    var html = '<div class="hover-card-header">' +
      '<div class="hover-card-icon" style="background:' + col + '">' + esc(ini) + '</div>' +
      '<div class="hover-card-title"><span class="hover-card-sym">' + esc(sym) + '</span>' +
      '<span class="hover-card-name">' + esc(name || sym) + '</span></div>' +
      (rank ? '<span class="hover-card-rank">TOP ' + rank + '</span>' : '') +
      '</div><div class="hover-card-grid">';
    if (last) {
      var d = last.c >= 0;
      html += '<div class="hover-card-stat"><span class="hover-card-stat-label">最新价</span><span class="hover-card-stat-value">' + fmt(last.p) + '</span></div>';
      html += '<div class="hover-card-stat"><span class="hover-card-stat-label">涨跌幅</span><span class="hover-card-stat-value ' + (d ? 'up' : 'down') + '">' + (d ? '+' : '') + last.c.toFixed(2) + '%</span></div>';
      html += '<div class="hover-card-stat"><span class="hover-card-stat-label">24h最高</span><span class="hover-card-stat-value">' + (last.h ? fmt(last.h) : '—') + '</span></div>';
      html += '<div class="hover-card-stat"><span class="hover-card-stat-label">24h最低</span><span class="hover-card-stat-value">' + (last.l ? fmt(last.l) : '—') + '</span></div>';
      html += '<div class="hover-card-stat hover-card-full"><span class="hover-card-stat-label">24h成交额</span><span class="hover-card-stat-value">' + fmtVol(last.v) + '</span></div>';
    } else if (chg != null) {
      var d2 = chg >= 0;
      html += '<div class="hover-card-stat hover-card-full"><span class="hover-card-stat-label">24h涨跌幅</span><span class="hover-card-stat-value ' + (d2 ? 'up' : 'down') + '">' + (d2 ? '+' : '') + chg.toFixed(2) + '%</span></div>';
    } else {
      html += '<div class="hover-card-stat hover-card-full"><span class="hover-card-stat-value" style="color:var(--muted);font-size:.72rem">暂无行情数据</span></div>';
    }
    html += '</div>';
    var desc = getCoinDesc(sym);
    if (desc) {
      html += '<div class="hover-card-desc"><div class="hover-card-desc-label">📖 币种简介</div><div class="hover-card-desc-text">' + esc(desc) + '</div></div>';
    }
    html += '<div class="hover-card-hint">币种信息卡片</div>';
    card.innerHTML = html;
    card.style.display = 'block';
    void card.offsetHeight;
    var r = el.getBoundingClientRect();
    var cw = card.offsetWidth, ch2 = card.offsetHeight;
    var x = r.left + r.width / 2 - cw / 2;
    var y = r.bottom + 10;
    if (x < 8) x = 8;
    if (x + cw > innerWidth - 8) x = innerWidth - cw - 8;
    if (y + ch2 > innerHeight - 8) y = r.top - ch2 - 10;
    if (y < 8) y = 8;
    card.style.left = x + 'px';
    card.style.top = y + 'px';
    card.classList.add('visible');
  }

  function doHide() {
    card.classList.remove('visible');
    curSym = null;
    hoverEl = null;
    setTimeout(function() { if (!card.classList.contains('visible')) card.style.display = 'none'; }, 250);
  }

  function hide() {
    clearTimeout(hideT);
    hideT = setTimeout(doHide, 120);
  }

  // ── Delegation via mouseover/mouseout (these bubble!) ──
  document.addEventListener('mouseover', function(e) {
    var t = e.target;
    if (!t.closest) return;
    var info = t.closest('.coin-info');
    var tag = t.closest('.trending-tag');
    var hit = info || tag;
    if (!hit) return;
    clearTimeout(hideT);  // cancel pending hide
    if (hit === hoverEl && card.classList.contains('visible')) return;  // already showing for this
    hoverEl = hit;
    if (info) {
      var row = info.closest('.table-row');
      if (!row || !row.dataset.sym) return;
      var sym = row.dataset.sym;
      var c = coins.find(function(x) { return x.symbol === sym; });
      show(sym, c ? c.name : sym, null, null, row);
    } else {
      var sym2 = tag.dataset.tsym;
      var nm = tag.dataset.tname;
      var tc = trendingCoins.find(function(x) { return x.symbol === sym2; });
      show(sym2, nm || sym2, tc ? tc.rank : null, tc ? tc.change24h : null, tag);
    }
  });

  document.addEventListener('mouseout', function(e) {
    var t = e.target;
    if (!t.closest) return;
    var info = t.closest('.coin-info');
    var tag = t.closest('.trending-tag');
    var hit = info || tag;
    if (!hit) return;
    var related = e.relatedTarget;
    // Still inside same target? Don't hide.
    if (related && hit.contains(related)) return;
    // Moved to the hover card itself? Don't hide.
    if (related && card.contains(related)) return;
    hide();
  });
})();

function escapeHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function toggleTrendingFromEl(el) {
  const sym = el.dataset.tsym;
  const name = el.dataset.tname;
  const idx = coins.findIndex(c => c.symbol === sym);
  if (idx >= 0) {
    // Remove ALL entries for this symbol (defensive against dupes)
    coins = coins.filter(c => c.symbol !== sym);
    delete coinApiMap[sym]; saveCoinApiMap();
    saveCoins();
  } else {
    if (activeApi >= 0) { coinApiMap[sym] = activeApi; saveCoinApiMap(); }
    coins.push({ symbol: sym, name: name || sym }); saveCoins();
  }
  render(); fetchPrices(); renderTrending();
}

// ── Fetch currency rates (best effort) ──
async function fetchCurrencyRates() {
  try {
    const d = await fetchWithCors('https://api.exchangerate-api.com/v4/latest/USD', 8000);
    if (d?.rates) {
      currencyRates.CNY = d.rates.CNY || 7.25;
      currencyRates.EUR = d.rates.EUR || 0.92;
    }
  } catch {}
}

// ════════════════════════════════════════
//  NEW FEATURES
// ════════════════════════════════════════

// ── Coin Search Autocomplete ──
let searchTimer = null;
let searchResults = [];
let searchIdx = -1;

function onSearchInput(val) {
  clearTimeout(searchTimer);
  const q = val.trim().toUpperCase();
  const dd = document.getElementById('searchDropdown');
  if (q.length < 1) { dd.classList.remove('open'); return; }

  // Quick local match first
  const localMatch = coins.filter(c => c.symbol.startsWith(q) || c.name.toUpperCase().includes(q));
  if (localMatch.length) {
    renderSearchResults(localMatch.map(c => ({
      symbol: c.symbol, name: c.name, rank: null, added: true
    })));
  }

  // Debounced API search
  searchTimer = setTimeout(async () => {
    if (q.length < 2) return;
    try {
      const data = await cgFetch('https://api.coingecko.com/api/v3/search?query=' + encodeURIComponent(q), 8000);
      if (data?.coins) {
        const apiResults = data.coins.slice(0, 15).map(c => ({
          symbol: (c.symbol || '').toUpperCase(),
          name: c.name || '',
          rank: c.market_cap_rank,
          added: coins.some(x => x.symbol === (c.symbol || '').toUpperCase()),
        }));
        // Merge: local matches first, then API
        const seen = new Set(localMatch.map(c => c.symbol));
        const merged = [...localMatch.map(c => ({ symbol: c.symbol, name: c.name, rank: null, added: true })),
          ...apiResults.filter(r => !seen.has(r.symbol))];
        renderSearchResults(merged.slice(0, 20));
      }
    } catch {}
  }, 350);
}

function renderSearchResults(results) {
  searchResults = results;
  searchIdx = -1;
  const dd = document.getElementById('searchDropdown');
  if (!results.length) { dd.classList.remove('open'); return; }
  dd.innerHTML = results.map((r, i) => {
    const rankBadge = r.rank ? `<span class="search-item-rank">#${r.rank}</span>` : '';
    const addedTag = r.added ? `<span class="search-item-added">✓ 已添加</span>` : '';
    return `<div class="search-item" data-idx="${i}" onclick="selectSearchResult(${i})">
      <span class="search-item-sym">${escapeHtml(r.symbol)}</span>
      <span class="search-item-name">${escapeHtml(r.name)}</span>
      ${rankBadge}${addedTag}
    </div>`;
  }).join('');
  dd.classList.add('open');
}

function onSearchKey(e) {
  const dd = document.getElementById('searchDropdown');
  if (!dd.classList.contains('open')) {
    if (e.key === 'Enter') addFromInput();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchIdx = Math.min(searchIdx + 1, searchResults.length - 1);
    highlightSearch();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchIdx = Math.max(searchIdx - 1, 0);
    highlightSearch();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (searchIdx >= 0 && searchIdx < searchResults.length) {
      selectSearchResult(searchIdx);
    } else if (searchResults.length) {
      selectSearchResult(0);
    } else {
      addFromInput();
    }
  } else if (e.key === 'Escape') {
    dd.classList.remove('open');
  }
}

function highlightSearch() {
  document.querySelectorAll('.search-item').forEach((el, i) => {
    el.classList.toggle('active', i === searchIdx);
  });
}

function selectSearchResult(idx) {
  const r = searchResults[idx];
  if (!r) return;
  addCoin(r.symbol, r.name);
  document.getElementById('input').value = '';
  document.getElementById('searchDropdown').classList.remove('open');
}

// Close dropdown on outside click
document.addEventListener('click', e => {
  if (!document.getElementById('addBar').contains(e.target)) {
    document.getElementById('searchDropdown').classList.remove('open');
  }
});

// ── Market Overview ──
async function fetchMarketOverview() {
  try {
    const [globalRes, fgRes] = await Promise.allSettled([
      cgFetch('https://api.coingecko.com/api/v3/global', 10000),
      fetchWithCors('https://api.alternative.me/fng/?limit=1', 8000),
    ]);

    const overview = document.getElementById('marketOverview');
    overview.style.display = 'flex';

    if (globalRes.status === 'fulfilled' && globalRes.value?.data) {
      const d = globalRes.value.data;
      const cap = d.total_market_cap?.usd;
      const chg = d.market_cap_change_percentage_24h_usd;
      const btcD = d.market_cap_percentage?.btc;

      document.getElementById('mktCap').textContent = cap ? fmtCompact(cap) : '--';
      if (chg != null) {
        const el = document.getElementById('mktCapChg');
        el.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
        el.className = 'market-stat-change ' + (chg >= 0 ? 'up' : 'down');
      }
      document.getElementById('btcDom').textContent = btcD != null ? btcD.toFixed(1) + '%' : '--';
      document.getElementById('mktChange').textContent = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '--';
      document.getElementById('mktChange').className = 'market-stat-value ' + (chg >= 0 ? 'up' : 'down');
      document.getElementById('mktChange').style.color = chg >= 0 ? 'var(--green)' : 'var(--red)';
    }

    if (fgRes.status === 'fulfilled' && fgRes.value?.data?.[0]) {
      const fg = fgRes.value.data[0];
      const val = parseInt(fg.value);
      const label = fg.value_classification;
      const fgEl = document.getElementById('fearGreed');
      fgEl.textContent = val + ' ' + label;
      fgEl.style.color = val <= 25 ? 'var(--red)' : val <= 50 ? '#ffaa00' : val <= 75 ? 'var(--accent)' : 'var(--green)';
    }
  } catch {}
}

function fmtCompact(n) {
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  return '$' + (n / 1e6).toFixed(2) + 'M';
}

// ── Portfolio / P&L ──
let portfolio = loadPortfolio();
function loadPortfolio() { try { const s = localStorage.getItem('crypto_portfolio'); if (s) return JSON.parse(s); } catch {} return []; }
function savePortfolio() { localStorage.setItem('crypto_portfolio', JSON.stringify(portfolio)); }

function openPortfolioModal() {
  const sel = document.getElementById('portfolioCoin');
  sel.innerHTML = coins.map(c => `<option value="${c.symbol}">${escapeHtml(c.symbol)} - ${escapeHtml(c.name)}</option>`).join('');
  renderPortfolioModal();
  document.getElementById('portfolioModalOverlay').classList.add('active');
}
function closePortfolioModal() { document.getElementById('portfolioModalOverlay').classList.remove('active'); }

function addPortfolioEntry() {
  const sym = document.getElementById('portfolioCoin').value;
  const buyPrice = parseFloat(document.getElementById('portfolioBuyPrice').value);
  const qty = parseFloat(document.getElementById('portfolioQty').value);
  if (!sym || isNaN(buyPrice) || buyPrice <= 0 || isNaN(qty) || qty <= 0) {
    showToast('请填写有效的买入价和数量', 'error'); return;
  }
  portfolio.push({ symbol: sym, buyPrice, qty, ts: Date.now() });
  savePortfolio();
  document.getElementById('portfolioBuyPrice').value = '';
  document.getElementById('portfolioQty').value = '';
  renderPortfolioModal();
  render(true);
  playNotifySound();
  showToast(`已添加 ${sym} 持仓：${qty} @ $${fmtRaw(buyPrice)}`);
}

function removePortfolioEntry(idx) {
  portfolio.splice(idx, 1);
  savePortfolio();
  renderPortfolioModal();
  render(true);
}

function renderPortfolioModal() {
  const summaryEl = document.getElementById('portfolioSummary');
  const listEl = document.getElementById('portfolioList');

  if (!portfolio.length) {
    summaryEl.innerHTML = '<div class="portfolio-total-label">暂无持仓记录</div>';
    listEl.innerHTML = '<div class="alert-empty">在下方添加你的持仓信息 👇</div>';
    return;
  }

  let totalCost = 0, totalValue = 0;
  const rows = portfolio.map((p, i) => {
    const ph = priceHistory[p.symbol];
    const last = ph && ph.length ? ph[ph.length - 1] : null;
    const currentPrice = last ? last.p : null;
    const cost = p.buyPrice * p.qty;
    const value = currentPrice ? currentPrice * p.qty : null;
    totalCost += cost;
    if (value != null) totalValue += value;

    const pnl = value != null ? value - cost : null;
    const pnlPct = value != null ? ((value - cost) / cost * 100) : null;
    const pnlClass = pnl != null ? (pnl >= 0 ? 'profit' : 'loss') : 'none';
    const pnlText = pnl != null ? `${pnl >= 0 ? '+' : ''}${fmt(pnl)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)` : '等待数据';

    return `<div class="portfolio-row">
      <span class="portfolio-row-sym">${escapeHtml(p.symbol)}</span>
      <span class="portfolio-row-detail">${p.qty} @ $${fmtRaw(p.buyPrice)}</span>
      <span class="portfolio-row-pnl ${pnlClass}">${pnlText}</span>
      <div class="portfolio-row-actions">
        <button class="del" onclick="removePortfolioEntry(${i})" title="删除">✕</button>
      </div>
    </div>`;
  }).join('');

  const totalPnl = totalValue > 0 ? totalValue - totalCost : null;
  const totalPnlPct = totalPnl != null && totalCost > 0 ? (totalPnl / totalCost * 100) : null;
  summaryEl.innerHTML = `
    <div class="portfolio-total-label">总成本 / 当前市值</div>
    <div class="portfolio-total-value">${fmt(totalCost)} ${totalValue > 0 ? '/ ' + fmt(totalValue) : ''}</div>
    ${totalPnl != null ? `<div class="portfolio-total-pnl" style="color:${totalPnl >= 0 ? 'var(--green)' : 'var(--red)'}">
      ${totalPnl >= 0 ? '+' : ''}${fmt(totalPnl)} (${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(2)}%)
    </div>` : ''}
  `;
  listEl.innerHTML = rows;
}

// P&L for table row
function getPnlHtml(sym) {
  const entries = portfolio.filter(p => p.symbol === sym);
  if (!entries.length) return '<span class="coin-pnl none">—</span>';
  const ph = priceHistory[sym];
  const last = ph && ph.length ? ph[ph.length - 1] : null;
  if (!last) return '<span class="coin-pnl none">--</span>';
  let totalCost = 0, totalValue = 0;
  entries.forEach(p => { totalCost += p.buyPrice * p.qty; totalValue += last.p * p.qty; });
  const pnl = totalValue - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost * 100) : 0;
  const cls = pnl >= 0 ? 'profit' : 'loss';
  return `<span class="coin-pnl ${cls}">${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</span>`;
}

// ── Help Modal ──
function openHelpModal() { document.getElementById('helpModalOverlay').classList.add('active'); }
function closeHelpModal() { document.getElementById('helpModalOverlay').classList.remove('active'); }

// ── Keyboard Shortcuts (统一事件监听，避免重复绑定) ──
function isAnyModalOpen() {
  return document.querySelector('.modal-overlay.active') !== null;
}

document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    document.getElementById('searchDropdown').classList.remove('open');
    return;
  }

  if (isInput || isAnyModalOpen()) return;

  const shortcuts = {
    '/': () => document.getElementById('input').focus(),
    'n': () => document.getElementById('input').focus(),
    'N': () => document.getElementById('input').focus(),
    'a': () => openAlertModal(),
    'A': () => openAlertModal(),
    'p': () => openPortfolioModal(),
    'P': () => openPortfolioModal(),
    'h': () => openHelpModal(),
    'H': () => openHelpModal(),
    'm': () => openNotifyModal(),
    'M': () => openNotifyModal(),
    's': () => toggleSound(),
    'S': () => toggleSound(),
    't': () => toggleTheme(),
    'T': () => toggleTheme(),
    'c': () => toggleColorInvert(),
    'C': () => toggleColorInvert(),
    'l': () => toggleSpell(),
    'L': () => toggleSpell(),
    'e': () => openNewsModal(),
    'E': () => openNewsModal(),
    'u': () => openUnlockModal(),
    'U': () => openUnlockModal(),
    'i': () => openAiAnalysis(),
    'I': () => openAiAnalysis(),
    'f': () => openForceAlertModal(),
    'F': () => openForceAlertModal(),
  };

  const handler = shortcuts[e.key];
  if (handler) {
    e.preventDefault();
    handler();
  }
});

// ── Tab Title Alert Badge ──
function updateTabBadge() {
  const activeAlerts = alerts.filter(a => {
    const ph = priceHistory[a.symbol];
    const last = ph && ph.length ? ph[ph.length - 1] : null;
    if (!last) return false;
    return (a.dir === 'above' && last.p >= a.price) || (a.dir === 'below' && last.p <= a.price);
  });
  const base = 'Crypto Monitor';
  if (activeAlerts.length) {
    document.title = `🔴 (${activeAlerts.length}) ${base}`;
  } else {
    document.title = base;
  }
  // Update badge on bell icon
  const badge = document.getElementById('alertBadge');
  if (activeAlerts.length) {
    badge.style.display = 'flex';
    badge.textContent = activeAlerts.length;
  } else {
    badge.style.display = 'none';
  }
}

// ── Onboarding ──
function showOnboarding() {
  if (localStorage.getItem('crypto_onboarded')) return;
  const tip = document.createElement('div');
  tip.className = 'onboarding-tip';
  tip.innerHTML = `
    <p>🎉 欢迎使用 <strong>Crypto Monitor</strong>！<br>
    顶部搜索框可以搜索并添加币种，点击 🔔 设置价格预警，📱 配置微信/邮件推送，💰 追踪持仓盈亏。</p>
    <div class="tip-keys">
      <span class="tip-key"><kbd>/</kbd> 搜索</span>
      <span class="tip-key"><kbd>A</kbd> 预警</span>
      <span class="tip-key"><kbd>P</kbd> 持仓</span>
      <span class="tip-key"><kbd>H</kbd> 帮助</span>
    </div>
    <button onclick="this.parentElement.remove();localStorage.setItem('crypto_onboarded','1')">开始使用 →</button>
  `;
  document.body.appendChild(tip);
}

// ── External Notification System ──
let notifyConfig = loadNotifyConfig();

function loadNotifyConfig() {
  const fallback = {
    serverchan: { enabled: false, key: '' },
    pushplus: { enabled: false, token: '' },
    email: { enabled: false, to: '', serviceId: '', templateId: '', publicKey: '' },
    iosPush: { enabled: false },
  };
  // Try localStorage first, then sessionStorage backup (iOS may clear localStorage under memory pressure)
  for (const storage of [localStorage, sessionStorage]) {
    try {
      const s = storage.getItem('crypto_notify');
      if (s) {
        const cfg = JSON.parse(s);
        // Ensure iosPush field exists (for older saved configs)
        if (!cfg.iosPush) cfg.iosPush = { enabled: false };
        return cfg;
      }
    } catch {}
  }
  return fallback;
}
function saveNotifyConfig() {
  // Read from DOM
  notifyConfig.serverchan.key = document.getElementById('serverchanKey')?.value || notifyConfig.serverchan.key;
  notifyConfig.pushplus.token = document.getElementById('pushplusToken')?.value || notifyConfig.pushplus.token;
  notifyConfig.email.to = document.getElementById('emailTo')?.value || notifyConfig.email.to;
  notifyConfig.email.serviceId = document.getElementById('emailServiceId')?.value || notifyConfig.email.serviceId;
  notifyConfig.email.templateId = document.getElementById('emailTemplateId')?.value || notifyConfig.email.templateId;
  notifyConfig.email.publicKey = document.getElementById('emailPublicKey')?.value || notifyConfig.email.publicKey;
  const json = JSON.stringify(notifyConfig);
  try { localStorage.setItem('crypto_notify', json); } catch {}
  try { sessionStorage.setItem('crypto_notify', json); } catch {}
}

// Restore iOS push toggle state from persisted config — called on visibilitychange/pageshow
// to handle iOS bfcache restores where the DOM checkbox may have reverted
function restoreNotifyToggleState() {
  try {
    const s = localStorage.getItem('crypto_notify') || sessionStorage.getItem('crypto_notify');
    if (s) {
      const cfg = JSON.parse(s);
      if (cfg.iosPush?.enabled && notifyConfig.iosPush) {
        notifyConfig.iosPush.enabled = true;
      }
    }
  } catch {}
  // Sync checkbox if modal is currently open
  const el = document.getElementById('notifyIosPush');
  if (el) el.checked = !!(notifyConfig.iosPush?.enabled);
}

function toggleNotifyChannel(ch) {
  const idMap = { serverchan: 'notifyServerChan', pushplus: 'notifyPushplus', email: 'notifyEmail', iosPush: 'notifyIosPush' };
  const el = document.getElementById(idMap[ch]);
  notifyConfig[ch].enabled = el?.checked || false;
  saveNotifyConfig();
  // For iOS push: if enabling, proactively request notification permission
  if (ch === 'iosPush' && notifyConfig.iosPush.enabled) {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(perm => {
        updateIosPushBtn();
        if (perm === 'granted') {
          registerServiceWorker().catch(() => {});
        }
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      registerServiceWorker().catch(() => {});
    }
  }
}

// ── iOS Push Notification ──
function updateIosPushBtn() {
  const btn = document.getElementById('iosPushEnableBtn');
  const status = document.getElementById('iosPushStatus');
  if (!btn) return;
  if (!('Notification' in window)) {
    btn.textContent = '此浏览器不支持';
    btn.disabled = true;
    status.textContent = '❌ 当前 iOS 版本不支持 Web 通知，请升级到 iOS 16.4+';
    status.className = 'notify-status err';
    return;
  }
  const perm = Notification.permission;
  if (perm === 'granted') {
    btn.textContent = '✅ 已授权';
    btn.disabled = true;
    if (isIOS) {
      status.innerHTML = '✅ 通知权限已开启<br><span style="font-size:0.62rem;color:var(--muted)">⚠️ iOS 限制：Safari 在后台时无法推送。请保持页面在前台或添加到主屏幕以获得最佳体验</span>';
    } else {
      status.textContent = '✅ 通知权限已开启，预警触发时会弹出通知';
    }
    status.className = 'notify-status ok';
  } else if (perm === 'denied') {
    btn.textContent = '已拒绝（需去设置开启）';
    btn.disabled = true;
    status.textContent = '❌ 通知权限被拒绝，请到 iPhone 设置 → Safari → 通知 中开启';
    status.className = 'notify-status err';
  } else {
    btn.textContent = '开启通知权限';
    btn.disabled = false;
    status.textContent = '';
    status.className = 'notify-status';
  }
}

async function enableIosPush() {
  if (!('Notification' in window)) {
    showToast('当前 iOS 版本不支持 Web 通知，请升级到 iOS 16.4+', 'error');
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    updateIosPushBtn();
    if (perm === 'granted') {
      // Register service worker for better background handling
      await registerServiceWorker();
      // Ensure the toggle is ON and persisted
      notifyConfig.iosPush.enabled = true;
      const el = document.getElementById('notifyIosPush');
      if (el) el.checked = true;
      saveNotifyConfig();
      showToast('✅ 通知权限已开启');
      // Send a test notification
      setTimeout(() => {
        sendBrowserNotification('🎉 Crypto Monitor', '通知已就绪！价格预警触发时会在锁屏弹出通知。', 'crypto-test');
      }, 500);
    } else if (perm === 'denied') {
      showToast('通知权限被拒绝，请到 iPhone 设置中手动开启', 'error');
    }
  } catch (e) {
    showToast('开启通知失败: ' + e.message, 'error');
  }
}

// Register a minimal service worker for iOS background notification support
let swRegistered = false;
async function registerServiceWorker() {
  if (swRegistered || !('serviceWorker' in navigator)) return false;
  // Already has a controller — good enough
  if (navigator.serviceWorker.controller) { swRegistered = true; return true; }
  const swCode = `
var CACHE_NAME = 'crypto-monitor-v1';
var STATIC_ASSETS = [
  './',
  './index.html',
  './crypto.css',
  './crypto.js'
];

// Install: pre-cache static assets
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS);
    }).then(function() { self.skipWaiting(); })
  );
});

// Activate: clean up old caches
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) {
        return caches.delete(k);
      }));
    }).then(function() { self.clients.claim(); })
  );
});

// Fetch: network-first for pages, cache-first for static assets
self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);
  // Skip non-GET and cross-origin requests
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Skip WebSocket and API requests
  if (url.pathname.includes('/api/') || url.protocol === 'ws:' || url.protocol === 'wss:') return;

  var isStatic = STATIC_ASSETS.some(function(a) {
    return url.pathname === new URL(a, self.location.origin).pathname || url.pathname.endsWith('.css') || url.pathname.endsWith('.js') || url.pathname.endsWith('.html');
  });

  if (isStatic) {
    // Cache-first for static assets (stale-while-revalidate)
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        var fetchPromise = fetch(e.request).then(function(res) {
          if (res && res.ok) {
            caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, res.clone()); });
          }
          return res;
        }).catch(function() { return cached; });
        return cached || fetchPromise;
      })
    );
  } else {
    // Network-first for everything else (pages, etc.)
    e.respondWith(
      fetch(e.request).then(function(res) {
        if (res && res.ok) {
          caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, res.clone()); });
        }
        return res;
      }).catch(function() { return caches.match(e.request); })
    );
  }
});

// Notification click: focus existing window or open new one
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(function(arr) {
    for (var i = 0; i < arr.length; i++) { if ('focus' in arr[i]) return arr[i].focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('/');
  }));
});
`;
  // Strategy 1: Blob URL (works on Android Chrome, not on iOS Safari)
  try {
    const blob = new Blob([swCode], { type: 'application/javascript' });
    const swUrl = URL.createObjectURL(blob);
    await navigator.serviceWorker.register(swUrl, { scope: '/' });
    swRegistered = true;
    await navigator.serviceWorker.ready;
    return true;
  } catch {}
  // Strategy 2: Register relative to current page path (works if served from same origin)
  try {
    // Try common SW file paths
    for (const path of ['./sw.js', '/sw.js', 'sw-crypto.js']) {
      try {
        const reg = await navigator.serviceWorker.register(path, { scope: '/' });
        swRegistered = true;
        await navigator.serviceWorker.ready;
        return true;
      } catch {}
    }
  } catch {}
  // Strategy 3: data: URL (limited browser support, but worth trying)
  try {
    const dataUrl = 'data:application/javascript;base64,' + btoa(swCode);
    await navigator.serviceWorker.register(dataUrl, { scope: '/' });
    swRegistered = true;
    await navigator.serviceWorker.ready;
    return true;
  } catch {}
  console.warn('All SW registration strategies failed — using direct Notification API');
  return false;
}

function openNotifyModal() {
  // Re-sync notifyConfig from storage in case it was updated in another tab or by lifecycle events
  try {
    const s = localStorage.getItem('crypto_notify') || sessionStorage.getItem('crypto_notify');
    if (s) {
      const cfg = JSON.parse(s);
      if (cfg.iosPush?.enabled && notifyConfig.iosPush) {
        notifyConfig.iosPush.enabled = true;
      }
    }
  } catch {}

  // Populate from saved config
  const sc = notifyConfig.serverchan;
  const pp = notifyConfig.pushplus;
  const em = notifyConfig.email;
  document.getElementById('notifyServerChan').checked = sc.enabled;
  document.getElementById('serverchanKey').value = sc.key || '';
  document.getElementById('notifyPushplus').checked = pp.enabled;
  document.getElementById('pushplusToken').value = pp.token || '';
  document.getElementById('notifyEmail').checked = em.enabled;
  document.getElementById('emailTo').value = em.to || '';
  document.getElementById('emailServiceId').value = em.serviceId || '';
  document.getElementById('emailTemplateId').value = em.templateId || '';
  document.getElementById('emailPublicKey').value = em.publicKey || '';

  // iOS Push section — show on iOS or if previously enabled (handles iPadOS/desktop Safari with Notification support)
  const iosSection = document.getElementById('iosPushChannel');
  const hasNotificationApi = 'Notification' in window;
  const iosPushWasEnabled = notifyConfig.iosPush?.enabled;
  if (isIOS || (hasNotificationApi && iosPushWasEnabled)) {
    iosSection.style.display = '';
    document.getElementById('notifyIosPush').checked = !!(notifyConfig.iosPush?.enabled);
    updateIosPushBtn();
  } else if (hasNotificationApi) {
    // Show on any browser that supports Notification API
    iosSection.style.display = '';
    document.getElementById('notifyIosPush').checked = false;
    updateIosPushBtn();
  } else {
    iosSection.style.display = 'none';
  }

  // Clear status
  ['serverchanStatus','pushplusStatus','emailStatus','iosPushStatus'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = ''; el.className = 'notify-status'; }
  });
  document.getElementById('notifyModalOverlay').classList.add('active');
}
function closeNotifyModal() {
  saveNotifyConfig();
  document.getElementById('notifyModalOverlay').classList.remove('active');
}

// Send notification to all enabled channels
async function sendExternalNotification(title, body) {
  const promises = [];
  const sc = notifyConfig.serverchan;
  const pp = notifyConfig.pushplus;
  const em = notifyConfig.email;
  const iosP = notifyConfig.iosPush;

  if (sc.enabled && sc.key) {
    promises.push(sendServerChan(sc.key, title, body).catch(e => console.warn('Server酱发送失败:', e)));
  }
  if (pp.enabled && pp.token) {
    promises.push(sendPushPlus(pp.token, title, body).catch(e => console.warn('PushPlus发送失败:', e)));
  }
  if (em.enabled && em.to && em.serviceId && em.templateId && em.publicKey) {
    promises.push(sendEmail(em, title, body).catch(e => console.warn('Email发送失败:', e)));
  }
  // iOS Push (enhanced browser notification)
  if (iosP?.enabled) {
    promises.push(Promise.resolve(sendBrowserNotification(title, body, 'crypto-push-' + Date.now())));
  }
  await Promise.allSettled(promises);
}

// Server酱 Turbo
async function sendServerChan(key, title, body) {
  const url = `https://sctapi.ftqq.com/${key}.send`;
  // Try direct first, then CORS proxy
  for (const makeUrl of [
    u => u,
    u => 'https://corsproxy.io/?' + encodeURIComponent(u),
  ]) {
    try {
      const res = await fetch(makeUrl(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(body)}`,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.code === 0) return true;
      }
    } catch {}
  }
  throw new Error('Server酱发送失败');
}

// PushPlus
async function sendPushPlus(token, title, body) {
  const url = 'https://www.pushplus.plus/send';
  for (const makeUrl of [
    u => u,
    u => 'https://corsproxy.io/?' + encodeURIComponent(u),
  ]) {
    try {
      const res = await fetch(makeUrl(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, title, content: body, template: 'txt' }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.code === 200) return true;
      }
    } catch {}
  }
  throw new Error('PushPlus发送失败');
}

// Email via EmailJS REST API
async function sendEmail(cfg, title, body) {
  const url = 'https://api.emailjs.com/api/v1.0/email/send';
  const payload = {
    service_id: cfg.serviceId,
    template_id: cfg.templateId,
    user_id: cfg.publicKey,
    template_params: {
      subject: title,
      message: body,
      to_email: cfg.to,
    },
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return true;
  } catch {}
  throw new Error('Email发送失败');
}

// Test notification
async function testNotify(ch) {
  const statusEl = document.getElementById(ch + 'Status');
  if (statusEl) { statusEl.textContent = '发送中…'; statusEl.className = 'notify-status'; }
  saveNotifyConfig();

  const testTitle = '🧪 Crypto Monitor 测试通知';
  const testBody = `这是一条测试消息，发送时间: ${new Date().toLocaleString('zh-CN')}\n\n如果你收到这条消息，说明通知渠道配置成功！✅`;

  try {
    if (ch === 'serverchan') {
      await sendServerChan(notifyConfig.serverchan.key, testTitle, testBody);
    } else if (ch === 'pushplus') {
      await sendPushPlus(notifyConfig.pushplus.token, testTitle, testBody);
    } else if (ch === 'email') {
      await sendEmail(notifyConfig.email, testTitle, testBody);
    } else if (ch === 'iosPush') {
      if (!('Notification' in window)) throw new Error('当前 iOS 版本不支持 Web 通知，请升级到 iOS 16.4+');
      if (Notification.permission !== 'granted') throw new Error('请先点击「开启通知权限」');
      sendBrowserNotification(testTitle, testBody, 'crypto-test-' + Date.now());
      if (statusEl) { statusEl.textContent = '✅ 通知已发送，请查看锁屏/通知中心'; statusEl.className = 'notify-status ok'; }
      playNotifySound();
      return;
    }
    if (statusEl) { statusEl.textContent = '✅ 发送成功，请检查接收端'; statusEl.className = 'notify-status ok'; }
    playNotifySound();
  } catch (e) {
    if (statusEl) { statusEl.textContent = '❌ ' + (e.message || '发送失败，请检查配置'); statusEl.className = 'notify-status err'; }
  }
}

// ── Modal Scroll Detection ──
function updateModalScrollState(modal) {
  if (!modal) return;
  const canScroll = modal.scrollHeight > modal.clientHeight + 5;
  modal.classList.toggle('modal-can-scroll', canScroll);
}

// Observe modals for scroll state changes
document.querySelectorAll('.modal').forEach(modal => {
  const observer = new MutationObserver(() => updateModalScrollState(modal));
  observer.observe(modal, { childList: true, subtree: true, characterData: true });
  modal.addEventListener('scroll', () => updateModalScrollState(modal));
});

// Update scroll state when modals open
const origOpenAlert = openAlertModal;
openAlertModal = function() { origOpenAlert(); setTimeout(() => updateModalScrollState(document.querySelector('#alertModalOverlay .modal')), 50); };
const origOpenNotify = openNotifyModal;
openNotifyModal = function() { origOpenNotify(); setTimeout(() => updateModalScrollState(document.querySelector('#notifyModalOverlay .modal')), 50); };
const origOpenPortfolio = openPortfolioModal;
openPortfolioModal = function() { origOpenPortfolio(); setTimeout(() => updateModalScrollState(document.querySelector('#portfolioModalOverlay .modal')), 50); };

// ══════════════════════════════════════════════════════════════
// ── Edge Keepalive System ──
// 解决 Edge「休眠标签页」(Sleeping Tabs) 导致的问题:
//   1. WebSocket 静默断开，不触发 onclose
//   2. setInterval 被暂停
//   3. 标签恢复前台后 WS 不自动重连
//   4. AudioContext / speechSynthesis 被冻结
// ══════════════════════════════════════════════════════════════

const KEEPALIVE = {
  wsHealthTimer: null,        // WS 健康检查定时器
  driftTimer: null,           // 计时漂移检测定时器
  lastDriftCheck: 0,          // 上次漂移检测时间戳
  lastDataReceived: {},       // { connKey: timestamp } — 每个 WS 连接最后收到数据的时间
  wsStaleThreshold: 30000,    // WS 超过 30s 没收到数据视为断开
  timerDriftThreshold: 15000, // setInterval 漂移超过 15s 说明被暂停过
  lastFetchTs: 0,             // 上次成功 fetch 的时间
  lastForegroundTs: 0,        // 上次进入前台的时间
  isEdge: /Edg\//.test(navigator.userAgent),
  edgeSleepRecoveryCount: 0,  // Edge 休眠恢复次数
};

// ── WS 健康检查: 每 10s 检查所有 WS 连接的数据新鲜度 ──
// 如果某个连接超过 30s 没收到数据，主动关闭并触发重连
function startWsHealthMonitor() {
  if (KEEPALIVE.wsHealthTimer) clearInterval(KEEPALIVE.wsHealthTimer);
  KEEPALIVE.wsHealthTimer = setInterval(() => {
    const now = Date.now();
    let deadCount = 0;

    wsConnections.forEach(conn => {
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
        deadCount++;
        return;
      }
      const lastData = KEEPALIVE.lastDataReceived[conn.connKey] || 0;
      if (lastData && (now - lastData) > KEEPALIVE.wsStaleThreshold) {
        console.warn(`[Keepalive] WS ${conn.connKey} 数据停滞 ${(now - lastData) / 1000}s，主动重连`);
        updateKeepaliveUI('recovering', '🔄 WS 重连…', `${conn.connKey} 停滞 ${(now - lastData) / 1000}s`);
        conn.ws.close(); // 触发 onclose → 自动重连
        deadCount++;
      }
    });

    // 如果所有 WS 都挂了，立即触发重连（不等 onclose）
    if (deadCount > 0 && deadCount === wsConnections.length && wsConnections.length > 0) {
      console.warn('[Keepalive] 所有 WS 连接均异常，强制重连');
      updateKeepaliveUI('recovering', '🔄 全量重连…', '所有连接异常');
      binanceWsConnect();
    }

    // 常态 UI 更新: 显示 WS 连接数和最后数据时间
    if (deadCount === 0 && wsConnections.length > 0) {
      const lastAny = Math.max(...wsConnections.map(c => KEEPALIVE.lastDataReceived[c.connKey] || 0));
      const secs = lastAny ? Math.round((now - lastAny) / 1000) : null;
      const wsOk = wsConnections.filter(c => c.ws && c.ws.readyState === WebSocket.OPEN).length;
      const detail = secs != null ? `${wsOk} 连接 · ${secs}s前` : `${wsOk} 连接`;
      updateKeepaliveUI('healthy', '保活就绪', detail);
    } else if (wsConnections.length === 0) {
      updateKeepaliveUI('healthy', '保活就绪', '轮询模式');
    }
  }, 10000);
}

// ── 在 applyCoinData 中记录数据接收时间 ──
// 包装原始的 applyCoinData，增加时间戳记录
const _origApplyCoinData = applyCoinData;
applyCoinData = function(sym, data, sourceLabel) {
  // 记录数据接收时间（用于 WS 健康检查）
  if (sourceLabel && sourceLabel.includes('WS')) {
    // 找到这个 symbol 对应的连接
    wsConnections.forEach(conn => {
      if (conn.symbols && conn.symbols.includes(sym)) {
        KEEPALIVE.lastDataReceived[conn.connKey] = Date.now();
      }
    });
  }
  KEEPALIVE.lastFetchTs = Date.now();
  return _origApplyCoinData(sym, data, sourceLabel);
};

// ── 计时漂移检测: 检测 setInterval 是否被 Edge 暂停 ──
// 原理: 用 performance.now() 检测实际经过的时间是否远超预期
function startDriftMonitor() {
  KEEPALIVE.lastDriftCheck = Date.now();
  if (KEEPALIVE.driftTimer) clearInterval(KEEPALIVE.driftTimer);
  KEEPALIVE.driftTimer = setInterval(() => {
    const now = Date.now();
    const elapsed = now - KEEPALIVE.lastDriftCheck;
    KEEPALIVE.lastDriftCheck = now;

    // 正常间隔 ~5000ms（我们设的 5s 定时器），如果超过 15s 说明被 Edge 暂停过
    if (elapsed > KEEPALIVE.timerDriftThreshold) {
      console.warn(`[Keepalive] 检测到计时漂移: ${(elapsed / 1000).toFixed(1)}s (Edge 休眠标签?)`);
      updateKeepaliveUI('recovering', '🔄 计时恢复…', `漂移 ${(elapsed / 1000).toFixed(1)}s`);
      recoverFromSleep('计时漂移检测');
    }
  }, 5000);
}

// ── Edge 休眠恢复: 标签从休眠中唤醒时的全面恢复 ──
let _lastRecoverTs = 0;
const RECOVER_COOLDOWN = 5000;  // 5秒内不重复完整恢复

function recoverFromSleep(reason, light) {
  const now = Date.now();

  // 轻量恢复：只拉价格，不刷新热搜/市场概览/不重建 timer
  if (light) {
    console.log(`[Keepalive] 轻量恢复: ${reason}`);
    fetchPrices();
    updateWsStatus();
    return;
  }

  // 完整恢复带冷却
  if (now - _lastRecoverTs < RECOVER_COOLDOWN) {
    console.log(`[Keepalive] 跳过重复恢复（冷却中）: ${reason}`);
    return;
  }
  _lastRecoverTs = now;

  KEEPALIVE.edgeSleepRecoveryCount++;
  console.log(`[Keepalive] Edge 休眠恢复 #${KEEPALIVE.edgeSleepRecoveryCount}: ${reason}`);

  // 1. 重建 fetch timer（Edge 可能已暂停 setInterval）
  if (timer) clearInterval(timer);
  timer = setInterval(fetchPrices, refreshSec * 1000);

  // 2. 立即拉取价格
  fetchPrices();

  // 3. 检查 WS 连接状态，强制重连不健康的连接
  const t = Date.now();
  let needsReconnect = false;
  wsConnections.forEach(conn => {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      needsReconnect = true;
    }
    // 检查数据新鲜度
    const lastData = KEEPALIVE.lastDataReceived[conn.connKey] || 0;
    if (lastData && (t - lastData) > KEEPALIVE.wsStaleThreshold) {
      needsReconnect = true;
    }
  });

  if (needsReconnect || wsConnections.length === 0) {
    console.warn('[Keepalive] WS 需要重连');
    binanceWsConnect();
  }

  // 4. 恢复 AudioContext
  recoverAudioContext();
  setTimeout(recoverAudioContext, 500);

  // 5. 恢复语音引擎
  recoverSpeechEngine('Edge休眠恢复');

  // 6. 重新请求 Wake Lock
  requestWakeLock();

  // 7. 恢复通知状态
  restoreNotifyToggleState();

  // 8. 拉取市场数据（fetchTrending 内部有 60s 冷却，不用担心重复）
  fetchMarketOverview();
  fetchTrending();

  // 9. 更新状态显示
  updateWsStatus();
}

// ── 增强的 visibilitychange 处理（Edge 专用）──
// Edge 的 Sleeping Tabs 可能在标签仍处于"非活动"状态时就开始冻结
// 我们需要在每次重新可见时做更彻底的恢复
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // 先计算距离上次前台的时间（在更新 lastForegroundTs 之前）
    const now = Date.now();
    const timeSinceForeground = KEEPALIVE.lastForegroundTs ? (now - KEEPALIVE.lastForegroundTs) : 0;
    KEEPALIVE.lastForegroundTs = now;

    const awaySec = timeSinceForeground / 1000;
    console.log(`[Keepalive] 页面回到前台（离开 ${awaySec.toFixed(0)}s）`);

    // 分级恢复：<10s 不做任何事，10-30s 轻量恢复（只拉价格），>30s 完整恢复
    if (awaySec < 10) {
      return;
    }

    if (awaySec < 30) {
      recoverFromSleep(`短时离开 ${awaySec.toFixed(0)}s`, true); // light=true
      return;
    }

    // 长时间离开：完整恢复
    const wasSleeping = true;
    if (KEEPALIVE.isEdge || wasSleeping) {
      console.log(`[Keepalive] Edge 标签恢复 (后台 ${awaySec.toFixed(0)}s)`);
      // 双段式恢复: 立即 + 1000ms（足够覆盖 Edge 的延迟唤醒，避免多余重连）
      // 但第二次调用用轻量模式，避免重复完整恢复
      recoverFromSleep('Edge visibilitychange');
      setTimeout(() => recoverFromSleep('Edge 延迟恢复(轻量)', true), 1000);
    }
  }
});

// ── 额外的 Edge 专用事件监听 ──
if (KEEPALIVE.isEdge) {
  // Edge 的 "freeze" 事件（Chrome 同源，但 Edge 的行为更激进）
  document.addEventListener('freeze', () => {
    console.log('[Keepalive] Edge freeze 事件');
  });

  document.addEventListener('resume', () => {
    console.log('[Keepalive] Edge resume 事件');
    // resume 事件不做完整恢复，visibilitychange 会处理
    // 只做轻量恢复兜底（防止 visibilitychange 没触发的边缘情况）
    recoverFromSleep('Edge resume(轻量)', true);
  });

  // Edge 的 "focus" 事件（点击地址栏后回来）
  window.addEventListener('focus', () => {
    const awaySec = KEEPALIVE.lastForegroundTs ? (Date.now() - KEEPALIVE.lastForegroundTs) / 1000 : 0;
    console.log(`[Keepalive] Edge window focus（离开 ${awaySec.toFixed(0)}s）`);
    if (awaySec > 30) {
      recoverFromSleep('Edge focus 恢复');
    } else if (awaySec > 10) {
      recoverFromSleep('Edge focus 恢复(轻量)', true);
    }
  });
}

// ── 保活状态 UI 更新 ──
function updateKeepaliveUI(state, text, detail) {
  const bar = document.getElementById('keepaliveBar');
  const icon = document.getElementById('kaIcon');
  const textEl = document.getElementById('kaText');
  const detailEl = document.getElementById('kaDetail');
  if (!bar) return;
  bar.className = 'keepalive-bar ' + state;
  textEl.textContent = text || '';
  detailEl.textContent = detail || '';
  // 恢复状态时自动在 4s 后回到健康态
  if (state === 'recovering') {
    clearTimeout(bar._resetTimer);
    bar._resetTimer = setTimeout(() => {
      updateKeepaliveUI('healthy', '保活就绪', '');
    }, 4000);
  }
}

// 在 recoverFromSleep 中插入 UI 更新（正确透传 light 参数）
const _origRecoverFromSleep = recoverFromSleep;
recoverFromSleep = function(reason, light) {
  updateKeepaliveUI('recovering', '🔄 恢复中…', reason);
  _origRecoverFromSleep(reason, light);
};

// 初始状态
setTimeout(() => updateKeepaliveUI('healthy', '保活就绪', KEEPALIVE.isEdge ? 'Edge 增强模式' : ''), 1000);

// ── 启动保活系统 ──
startWsHealthMonitor();
startDriftMonitor();
console.log(`[Keepalive] Edge 保活系统启动 (Edge=${KEEPALIVE.isEdge})`);

// ══════════════════════════════════════════════════════════════
// ── News / Announcement Aggregation ──
// ══════════════════════════════════════════════════════════════
let newsData = [];
let newsFilter = 'all';
let _lastNewsFetch = 0;
const NEWS_COOLDOWN = 300000; // 5 分钟冷却

// ── RSS 源定义 ──
const RSS_FEEDS = [
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss',      maxItems: 15 },
  { name: 'The Block',     url: 'https://www.theblock.co/rss.xml',    maxItems: 10 },
  { name: 'CryptoNews',    url: 'https://cryptonews.com/news/feed/',  maxItems: 10 },
];

// ── RSS XML 解析 ──
function parseRssItems(xml, sourceName, maxItems) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match, count = 0;
  while ((match = itemRegex.exec(xml)) !== null && count < maxItems) {
    const block = match[1];
    const title = extractXmlTag(block, 'title');
    const link  = extractXmlTag(block, 'link');
    const desc  = extractXmlTag(block, 'description');
    const dateStr = extractXmlTag(block, 'pubDate');
    if (!title) continue;
    const ts = dateStr ? (new Date(dateStr).getTime() || Date.now()) : Date.now();
    const syms = extractSymbols(title + ' ' + (desc || ''));
    const cleanDesc = (desc || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim();
    items.push({
      type: 'news',
      title: title.length > 90 ? title.slice(0, 90) + '…' : title,
      desc: cleanDesc.length > 200 ? cleanDesc.slice(0, 200) + '…' : cleanDesc,
      coins: syms, source: sourceName, ts,
      url: link || '', isArticle: true, important: false,
    });
    count++;
  }
  return items;
}
function extractXmlTag(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

// 通过 CORS 代理拉取单个 RSS 源
async function fetchRssFeed(url, sourceName, maxItems) {
  for (const makeUrl of CORS_PROXIES) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(makeUrl(url), { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const xml = await r.text();
      if (!xml.includes('<item')) continue;
      return parseRssItems(xml, sourceName, maxItems);
    } catch { clearTimeout(t); }
  }
  return [];
}

function openNewsModal() {
  document.getElementById('newsModalOverlay').classList.add('active');
  fetchNews();
}
function closeNewsModal() {
  document.getElementById('newsModalOverlay').classList.remove('active');
}

function filterNews(filter, btn) {
  newsFilter = filter;
  document.querySelectorAll('#newsModalOverlay .news-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderNews();
}

async function fetchNews() {
  const now = Date.now();
  // 冷却中且有数据：直接渲染，不重复请求
  if (now - _lastNewsFetch < NEWS_COOLDOWN && newsData.length) { renderNews(); return; }
  _lastNewsFetch = now;

  const listEl = document.getElementById('newsList');
  const hasCachedNews = newsData.length > 0;
  if (!hasCachedNews) {
    listEl.innerHTML = '<div class="news-loading"><span class="spinner"></span>加载中…</div>';
  }

  const newItems = [];

  try {
    // ── 1. 并行拉取 3 个 RSS 源 ──
    const rssResults = await Promise.allSettled(
      RSS_FEEDS.map(feed => fetchRssFeed(feed.url, feed.name, feed.maxItems))
    );
    rssResults.forEach((res, i) => {
      if (res.status === 'fulfilled' && res.value.length) {
        newItems.push(...res.value);
        console.log(`[News] ${RSS_FEEDS[i].name}: ${res.value.length} 条`);
      } else {
        console.warn(`[News] ${RSS_FEEDS[i].name} 拉取失败`);
      }
    });

    // ── 2. 行情异动提醒 ──
    coins.forEach(c => {
      const ph = priceHistory[c.symbol];
      if (!ph || ph.length < 2) return;
      const last = ph[ph.length - 1];
      const prev = ph[Math.max(0, ph.length - 12)];
      if (!last || !prev) return;
      const pct = prev.p ? ((last.p - prev.p) / prev.p * 100) : 0;
      if (Math.abs(pct) >= 2) {
        newItems.push({
          type: pct > 0 ? 'news' : 'alert',
          title: `${c.symbol} ${pct > 0 ? '📈 强势拉升' : '📉 快速下挫'} ${Math.abs(pct).toFixed(2)}%`,
          desc: `${c.name} 短时间内${pct > 0 ? '大幅上涨' : '明显回落'}，当前价格 ${fmt(last.p)}，24h交易额 ${fmtVol(last.v)}。`,
          coins: [c.symbol], source: '行情异动', ts: Date.now(),
          important: Math.abs(pct) > 5, url: getCoinUrl(c.symbol), isArticle: false,
        });
      }
      // 高交易额提醒
      if (last.v > 1e8) {
        newItems.push({
          type: 'news',
          title: `${c.symbol} 24h 交易额突破 ${fmtVol(last.v)}`,
          desc: `${c.name} 近期交易活跃，涨跌 ${last.c >= 0 ? '+' : ''}${last.c.toFixed(2)}%。`,
          coins: [c.symbol], source: '交易量监控', ts: Date.now() - 60000,
          important: false, url: getCoinUrl(c.symbol), isArticle: false,
        });
      }
    });

    // ── 3. 去重 + 排序 ──
    const seen = new Set();
    const deduped = newItems.filter(item => {
      const key = item.title.slice(0, 40).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    deduped.sort((a, b) => {
      if (a.important !== b.important) return b.important ? 1 : -1;
      return b.ts - a.ts;
    });

    if (deduped.length) {
      newsData = deduped;
      try { localStorage.setItem('crypto_news_cache', JSON.stringify({ data: newsData, ts: Date.now() })); } catch {}
    } else if (hasCachedNews) {
      console.log('[News] API 无数据，保留缓存');
    } else {
      // 无数据无缓存：尝试 localStorage
      try {
        const cached = JSON.parse(localStorage.getItem('crypto_news_cache') || 'null');
        if (cached?.data?.length) newsData = cached.data;
      } catch {}
    }

  } catch (e) {
    console.warn('[News] fetch error:', e);
  }

  if (!newsData.length) {
    newsData = [{
      type: 'news', title: '暂无最新新闻', desc: '请稍后重试。',
      coins: [], source: '系统', ts: Date.now(), important: false,
    }];
  }
  renderNews();
}

// Extract known coin symbols from text
function extractSymbols(text) {
  const upper = text.toUpperCase();
  const found = [];
  const knownSymbols = ['BTC','ETH','BNB','SOL','XRP','ADA','DOGE','TRX','AVAX','DOT',
    'LINK','MATIC','UNI','SHIB','LTC','BCH','ATOM','XLM','NEAR','APT','ARB','OP',
    'FIL','INJ','SUI','PEPE','SEI','WLD','TIA','AAVE','MKR','CRV','LDO','STX',
    'RENDER','FET','TON','WIF','JUP','ENA','PYTH','JTO','ALT','DYM','ONDO','WLFI'];
  for (const sym of knownSymbols) {
    // Match symbol as whole word (with word boundary or common separators)
    const re = new RegExp('(?:^|[\\s$¥€,，。])' + sym + '(?:[\\s$¥€,，。：:]|$)', 'i');
    if (re.test(upper) || upper.includes(sym + '/') || upper.includes(sym + 'USDT') || upper.includes(sym + '-USDT')) {
      if (!found.includes(sym)) found.push(sym);
    }
  }
  return found;
}

// CoinGecko URL helper
const COIN_ID_MAP = {
  BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binance-coin', SOL: 'solana', XRP: 'ripple',
  ADA: 'cardano', DOGE: 'dogecoin', TRX: 'tron', AVAX: 'avalanche', DOT: 'polkadot',
  LINK: 'chainlink', MATIC: 'matic-network', UNI: 'uniswap', SHIB: 'shiba-inu',
  LTC: 'litecoin', BCH: 'bitcoin-cash', ATOM: 'cosmos', XLM: 'stellar',
  NEAR: 'near-protocol', APT: 'aptos', ARB: 'arbitrum', OP: 'optimism',
  FIL: 'filecoin', INJ: 'injective', SUI: 'sui', PEPE: 'pepe',
  SEI: 'sei', WLD: 'worldcoin-wlfi', TIA: 'celestia', ORDI: 'ordinals',
  AAVE: 'aave', MKR: 'maker', CRV: 'curve-dao-token', LDO: 'lido-dao',
  STX: 'stacks', RENDER: 'render-token', FET: 'fetch-ai',
  WLFI: 'world-liberty-financial', TON: 'the-open-network',
  WIF: 'dogwifcoin', JUP: 'jupiter-exchange-solana',
};
function getCoinUrl(sym) {
  const id = COIN_ID_MAP[sym] || sym.toLowerCase();
  return `https://www.coingecko.com/en/coins/${id}`;
}

// Dynamic relative time from timestamp
function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return '刚刚';
  if (sec < 60) return sec + '秒前';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + '分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + '小时前';
  return Math.floor(hr / 24) + '天前';
}

function renderNews() {
  const listEl = document.getElementById('newsList');
  const watchlistSymbols = new Set(coins.map(c => c.symbol));

  let filtered = newsData;
  if (newsFilter === 'watchlist') {
    filtered = newsData.filter(n => n.coins?.some(c => watchlistSymbols.has(c)));
  } else if (newsFilter === 'important') {
    filtered = newsData.filter(n => n.important);
  }

  if (!filtered.length) {
    listEl.innerHTML = '<div class="alert-empty">没有符合条件的新闻</div>';
    return;
  }

  listEl.innerHTML = filtered.map(n => {
    const tagClass = n.type === 'alert' ? 'tag-alert' : n.type === 'announcement' ? 'tag-announcement' : n.type === 'watchlist' ? 'tag-watchlist' : 'tag-news';
    const tagText = n.type === 'alert' ? '⚠️ 重要' : n.type === 'announcement' ? '📢 公告' : n.type === 'watchlist' ? '👁️ 自选' : '📰 新闻';

    const coinsHtml = (n.coins || []).map(s => {
      const inWl = watchlistSymbols.has(s);
      return `<span class="news-card-coin${inWl ? ' in-watchlist' : ''}">${s}</span>`;
    }).join('');

    const url = n.url || '';
    const timeText = relativeTime(n.ts);
    // 区分：是真实文章链接，还是系统生成的行情链接
    const isArticle = n.isArticle || false;
    const linkLabel = isArticle ? '🔗 查看原文' : '📊 查看行情';

    if (url) {
      return `<a class="news-card-link-wrap" href="${escapeAttr(url)}" target="_blank" rel="noopener">
        <div class="news-card type-${n.type}${n.important ? ' important' : ''}" style="cursor:pointer">
          <div class="news-card-header">
            <span class="news-card-tag ${tagClass}">${tagText}</span>
            <div class="news-card-coins">${coinsHtml}</div>
          </div>
          <div class="news-card-title">${escapeHtml(n.title)}</div>
          <div class="news-card-desc">${escapeHtml(n.desc)}</div>
          <div class="news-card-meta">
            <span class="news-card-source">${escapeHtml(n.source)}</span>
            <span class="news-card-time">${timeText}</span>
            <span class="news-card-link">${linkLabel}</span>
          </div>
        </div>
      </a>`;
    }

    return `<div class="news-card type-${n.type}${n.important ? ' important' : ''}">
      <div class="news-card-header">
        <span class="news-card-tag ${tagClass}">${tagText}</span>
        <div class="news-card-coins">${coinsHtml}</div>
      </div>
      <div class="news-card-title">${escapeHtml(n.title)}</div>
      <div class="news-card-desc">${escapeHtml(n.desc)}</div>
      <div class="news-card-meta">
        <span class="news-card-source">${escapeHtml(n.source)}</span>
        <span class="news-card-time">${timeText}</span>
      </div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
// ── Token Unlock Notifications ──
// ══════════════════════════════════════════════════════════════
let unlockData = [];
let unlockFilter = 'all';
let _lastUnlockFetch = 0;
const UNLOCK_COOLDOWN = 120000;

// Known upcoming token unlocks (simulated + real data)
const KNOWN_UNLOCKS = [
  { symbol: 'ARB', name: 'Arbitrum', date: '2026-04-16', amount: 92650000, totalSupply: 10000000000, pct: 0.93, cliff: '团队/投资人解锁' },
  { symbol: 'OP', name: 'Optimism', date: '2026-04-30', amount: 31340000, totalSupply: 4294967296, pct: 0.73, cliff: '核心贡献者' },
  { symbol: 'SUI', name: 'Sui', date: '2026-04-01', amount: 64190000, totalSupply: 10000000000, pct: 0.64, cliff: '社区储备' },
  { symbol: 'APT', name: 'Aptos', date: '2026-04-12', amount: 11310000, totalSupply: 1112026558, pct: 1.02, cliff: '基金会' },
  { symbol: 'TIA', name: 'Celestia', date: '2026-03-30', amount: 5680000, totalSupply: 1000000000, pct: 0.57, cliff: '早期投资者' },
  { symbol: 'WLD', name: 'Worldcoin', date: '2026-04-07', amount: 6620000, totalSupply: 10000000000, pct: 0.07, cliff: '社区发放' },
  { symbol: 'SEI', name: 'Sei', date: '2026-04-15', amount: 55500000, totalSupply: 10000000000, pct: 0.56, cliff: '生态激励' },
  { symbol: 'STRK', name: 'Starknet', date: '2026-04-20', amount: 64000000, totalSupply: 10000000000, pct: 0.64, cliff: '早期贡献者' },
  { symbol: 'PYTH', name: 'Pyth Network', date: '2026-04-25', amount: 127000000, totalSupply: 10000000000, pct: 1.27, cliff: '生态系统' },
  { symbol: 'JTO', name: 'Jito', date: '2026-05-01', amount: 11000000, totalSupply: 1000000000, pct: 1.10, cliff: '核心团队' },
  { symbol: 'JUP', name: 'Jupiter', date: '2026-04-08', amount: 58000000, totalSupply: 10000000000, pct: 0.58, cliff: '团队解锁' },
  { symbol: 'ENA', name: 'Ethena', date: '2026-04-02', amount: 128000000, totalSupply: 15000000000, pct: 0.85, cliff: '投资者' },
  { symbol: 'ALT', name: 'AltLayer', date: '2026-04-18', amount: 68000000, totalSupply: 10000000000, pct: 0.68, cliff: '团队/顾问' },
  { symbol: 'DYM', name: 'Dymension', date: '2026-04-22', amount: 17500000, totalSupply: 1000000000, pct: 1.75, cliff: '生态激励' },
  { symbol: 'ONDO', name: 'Ondo Finance', date: '2026-05-05', amount: 19500000, totalSupply: 10000000000, pct: 0.20, cliff: '协议解锁' },
];

function openUnlockModal() {
  document.getElementById('unlockModalOverlay').classList.add('active');
  fetchUnlocks();
}
function closeUnlockModal() {
  document.getElementById('unlockModalOverlay').classList.remove('active');
}

function filterUnlocks(filter, btn) {
  unlockFilter = filter;
  document.querySelectorAll('#unlockModalOverlay .news-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderUnlocks();
}

async function fetchUnlocks() {
  const now = Date.now();
  if (now - _lastUnlockFetch < UNLOCK_COOLDOWN && unlockData.length) { renderUnlocks(); return; }
  _lastUnlockFetch = now;

  const listEl = document.getElementById('unlockList');
  listEl.innerHTML = '<div class="news-loading"><span class="spinner"></span>加载中…</div>';

  unlockData = KNOWN_UNLOCKS.map(u => {
    const unlockDate = new Date(u.date);
    const daysUntil = Math.ceil((unlockDate - new Date()) / 86400000);
    const usdValue = priceHistory[u.symbol]?.[priceHistory[u.symbol].length - 1]?.p
      ? u.amount * priceHistory[u.symbol][priceHistory[u.symbol].length - 1].p
      : null;

    // Calculate unlocked so far (simulate based on time since a reference point)
    const totalCliffMonths = 12; // assume 12 month cliff
    const monthsFromStart = Math.max(0, daysUntil / 30);
    const unlockedPct = Math.min(100, Math.max(5, ((totalCliffMonths - monthsFromStart) / totalCliffMonths) * 100));

    return {
      ...u,
      unlockDate,
      daysUntil,
      usdValue,
      unlockedPct,
      isWatchlist: coins.some(c => c.symbol === u.symbol),
    };
  }).sort((a, b) => a.daysUntil - b.daysUntil);

  renderUnlocks();
}

function renderUnlocks() {
  const listEl = document.getElementById('unlockList');
  const summaryEl = document.getElementById('unlockSummary');
  const watchlistSymbols = new Set(coins.map(c => c.symbol));
  const now = new Date();

  let filtered = unlockData;
  if (unlockFilter === 'watchlist') {
    filtered = unlockData.filter(u => watchlistSymbols.has(u.symbol));
  } else if (unlockFilter === '7d') {
    filtered = unlockData.filter(u => u.daysUntil <= 7 && u.daysUntil >= 0);
  } else if (unlockFilter === '30d') {
    filtered = unlockData.filter(u => u.daysUntil <= 30 && u.daysUntil >= 0);
  }

  // Summary
  const upcoming7d = unlockData.filter(u => u.daysUntil > 0 && u.daysUntil <= 7);
  const upcoming30d = unlockData.filter(u => u.daysUntil > 0 && u.daysUntil <= 30);
  const watchlistUnlocks = unlockData.filter(u => watchlistSymbols.has(u.symbol) && u.daysUntil > 0);
  const totalValue = unlockData.reduce((s, u) => s + (u.usdValue || 0), 0);

  summaryEl.innerHTML = `
    <div class="unlock-summary-stat">
      <span class="unlock-summary-label">7天内解锁</span>
      <span class="unlock-summary-value${upcoming7d.length ? ' urgent' : ''}">${upcoming7d.length} 个</span>
    </div>
    <div class="unlock-summary-stat">
      <span class="unlock-summary-label">30天内解锁</span>
      <span class="unlock-summary-value${upcoming30d.length ? ' soon' : ''}">${upcoming30d.length} 个</span>
    </div>
    <div class="unlock-summary-stat">
      <span class="unlock-summary-label">自选相关</span>
      <span class="unlock-summary-value">${watchlistUnlocks.length} 个</span>
    </div>
    <div class="unlock-summary-stat">
      <span class="unlock-summary-label">预估总价值</span>
      <span class="unlock-summary-value">${totalValue ? fmtCompact(totalValue) : '--'}</span>
    </div>
  `;

  if (!filtered.length) {
    listEl.innerHTML = '<div class="alert-empty">没有符合条件的解锁事件</div>';
    return;
  }

  listEl.innerHTML = filtered.map(u => {
    const isUrgent = u.daysUntil <= 7 && u.daysUntil > 0;
    const isPast = u.daysUntil <= 0;
    const daysClass = u.daysUntil <= 7 ? 'days-urgent' : u.daysUntil <= 30 ? 'days-soon' : 'days-normal';
    const daysText = isPast ? '已解锁' : u.daysUntil === 0 ? '今天' : `${u.daysUntil}天后`;
    const dateStr = u.unlockDate.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });

    const color = hashColor(u.symbol);
    const ini = u.symbol.length > 4 ? u.symbol.slice(0, 3) : u.symbol;

    const barColor = u.unlockedPct > 75 ? 'var(--red)' : u.unlockedPct > 50 ? '#f0a030' : 'var(--accent)';

    return `<div class="unlock-card${u.isWatchlist ? ' is-watchlist' : ''}${isUrgent ? ' urgent' : ''}">
      <div class="unlock-card-header">
        <div class="unlock-card-icon" style="background:${color}">${escapeHtml(ini)}</div>
        <div class="unlock-card-info">
          <span class="unlock-card-sym">${escapeHtml(u.symbol)}${u.isWatchlist ? ' <span style="font-size:0.6rem;color:var(--green)">👁️自选</span>' : ''}</span>
          <span class="unlock-card-name">${escapeHtml(u.name)} · ${escapeHtml(u.cliff)}</span>
        </div>
        <div class="unlock-card-date">
          <div class="unlock-card-date-value">${dateStr}</div>
          <span class="unlock-card-days ${daysClass}">${daysText}</span>
        </div>
      </div>
      <div class="unlock-card-body">
        <div class="unlock-card-stat">
          <span class="unlock-card-stat-label">解锁数量</span>
          <span class="unlock-card-stat-value">${fmtUnlockAmount(u.amount)} ${u.symbol}</span>
        </div>
        <div class="unlock-card-stat">
          <span class="unlock-card-stat-label">占总供应量</span>
          <span class="unlock-card-stat-value">${u.pct.toFixed(2)}%</span>
        </div>
        <div class="unlock-card-stat">
          <span class="unlock-card-stat-label">预估价值</span>
          <span class="unlock-card-stat-value">${u.usdValue ? fmtCompact(u.usdValue) : '—'}</span>
        </div>
        <div class="unlock-card-stat">
          <span class="unlock-card-stat-label">当前价格</span>
          <span class="unlock-card-stat-value">${priceHistory[u.symbol]?.[priceHistory[u.symbol].length - 1]?.p ? fmt(priceHistory[u.symbol][priceHistory[u.symbol].length - 1].p) : '—'}</span>
        </div>
        <div class="unlock-card-bar">
          <div class="unlock-bar-bg">
            <div class="unlock-bar-fill" style="width:${u.unlockedPct}%;background:${barColor}"></div>
          </div>
          <div class="unlock-bar-label">
            <span>已解锁 ${u.unlockedPct.toFixed(0)}%</span>
            <span>总供应 ${fmtUnlockAmount(u.totalSupply)}</span>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function fmtUnlockAmount(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return n.toLocaleString();
}

function hashColor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const c = (h >>> 0) & 0xFFFFFF;
  return '#' + c.toString(16).padStart(6, '0');
}

// ══════════════════════════════════════════════════════════════
// ── AI Smart Analysis ──
// ══════════════════════════════════════════════════════════════

function openAiAnalysis() {
  document.getElementById('aiModalOverlay').classList.add('active');
  document.getElementById('aiResult').style.display = 'none';
}
function closeAiModal() {
  document.getElementById('aiModalOverlay').classList.remove('active');
}

function runAiAnalysis(type) {
  const resultEl = document.getElementById('aiResult');
  const titleEl = document.getElementById('aiResultTitle');
  const timeEl = document.getElementById('aiResultTime');
  const bodyEl = document.getElementById('aiResultBody');

  resultEl.style.display = 'block';
  bodyEl.innerHTML = '<div class="ai-loading"><span class="spinner"></span>AI 正在分析行情数据…</div>';

  const titles = {
    market: '📊 市场全景分析',
    coins: '💰 自选币种诊断',
    entry: '🎯 入手区间建议',
    risk: '⚠️ 风险评估报告',
  };
  titleEl.textContent = titles[type] || 'AI 分析';
  timeEl.textContent = new Date().toLocaleString('zh-CN');

  // Simulate analysis delay
  setTimeout(() => {
    let analysis = '';
    switch (type) {
      case 'market': analysis = generateMarketAnalysis(); break;
      case 'coins': analysis = generateCoinAnalysis(); break;
      case 'entry': analysis = generateEntryAnalysis(); break;
      case 'risk': analysis = generateRiskAnalysis(); break;
    }
    bodyEl.innerHTML = analysis;
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 1500 + Math.random() * 1000);
}

function generateMarketAnalysis() {
  const fearGreedEl = document.getElementById('fearGreed');
  const fg = fearGreedEl?.textContent || '--';
  const mktChgEl = document.getElementById('mktChange');
  const mktChg = mktChgEl?.textContent || '--';
  const btcDomEl = document.getElementById('btcDom');
  const btcDom = btcDomEl?.textContent || '--';
  const mktCapEl = document.getElementById('mktCap');
  const mktCap = mktCapEl?.textContent || '--';

  const btcPh = priceHistory['BTC'];
  const btcLast = btcPh?.length ? btcPh[btcPh.length - 1] : null;
  const ethPh = priceHistory['ETH'];
  const ethLast = ethPh?.length ? ethPh[ethPh.length - 1] : null;

  let btcTrend = '';
  if (btcPh && btcPh.length >= 5) {
    const first = btcPh[0].p;
    const last = btcPh[btcPh.length - 1].p;
    const pct = ((last - first) / first * 100);
    btcTrend = pct > 1 ? '<span class="ai-positive">上升趋势</span>' : pct < -1 ? '<span class="ai-negative">下降趋势</span>' : '<span class="ai-warning">横盘震荡</span>';
  }

  let fgAnalysis = '';
  const fgNum = parseInt(fg);
  if (!isNaN(fgNum)) {
    if (fgNum <= 20) fgAnalysis = '市场处于<span class="ai-negative">极度恐惧</span>状态，通常意味着超卖，可能是较好的买入时机（但也可能继续下跌）。建议分批小额建仓。';
    else if (fgNum <= 40) fgAnalysis = '市场处于<span class="ai-warning">恐惧</span>状态，多数投资者持观望态度。可关注超跌币种的反弹机会。';
    else if (fgNum <= 60) fgAnalysis = '市场情绪<span class="ai-positive">中性</span>，没有明显的多空倾向。适合根据技术面做短线操作。';
    else if (fgNum <= 80) fgAnalysis = '市场处于<span class="ai-positive">贪婪</span>状态，投资者热情较高。注意追高风险，建议做好止盈。';
    else fgAnalysis = '市场处于<span class="ai-negative">极度贪婪</span>状态，泡沫风险增加。建议逐步减仓，锁定利润。';
  }

  const analysis = `
<span class="ai-section-title">📈 市场概况</span>
• 总市值: ${mktCap}
• 24h 涨跌: ${mktChg}
• BTC 市场占比: ${btcDom}
• 恐惧贪婪指数: ${fg}

<span class="ai-section-title">₿ BTC 走势分析</span>
${btcLast ? `• 当前价格: ${fmt(btcLast.p)}\n• 24h 区间: ${fmt(btcLast.low)} ~ ${fmt(btcLast.high)}\n• 短期趋势: ${btcTrend}` : '• 暂无实时数据，请等待行情更新'}

${ethLast ? `<span class="ai-section-title">⟠ ETH 走势</span>\n• 当前价格: ${fmt(ethLast.p)}\n• 24h 区间: ${fmt(ethLast.low)} ~ ${fmt(ethLast.high)}\n• ETH/BTC 比率: ${btcLast ? (ethLast.p / btcLast.p).toFixed(5) : '—'}` : ''}

<span class="ai-section-title">😱 恐惧贪婪指数解读</span>
${fgAnalysis || '• 数据加载中，请稍后查看'}

<span class="ai-section-title">💡 AI 策略建议</span>
• <span class="ai-positive">若恐惧指数 < 25</span>: 历史上是较好的中长期布局时机
• <span class="ai-warning">若恐惧指数 25-55</span>: 观望为主，可小仓位试探
• <span class="ai-negative">若恐惧指数 > 75</span>: 注意控制仓位，设置好止损止盈
• BTC 占比 > 50% 时，市场资金集中在 BTC，山寨币表现可能偏弱
• BTC 占比下降时，资金可能正在流入山寨币（alt season 信号）`;

  return analysis;
}

function generateCoinAnalysis() {
  if (!coins.length) return '<span class="ai-warning">⚠️ 请先添加自选币种后再进行分析。</span>';

  const sections = ['<span class="ai-section-title">📋 自选币种逐一诊断</span>'];

  coins.forEach(c => {
    const ph = priceHistory[c.symbol];
    if (!ph || ph.length < 3) {
      sections.push(`<span class="ai-section-title">${c.symbol} (${c.name})</span>\n• 数据不足，等待行情更新中…`);
      return;
    }

    const last = ph[ph.length - 1];
    const prev = ph[Math.max(0, ph.length - 12)];
    const change1m = prev.p ? ((last.p - prev.p) / prev.p * 100) : 0;

    // Calculate RSI-like indicator from price history
    let gains = 0, losses = 0;
    for (let i = Math.max(1, ph.length - 15); i < ph.length; i++) {
      const diff = ph[i].p - ph[i - 1].p;
      if (diff > 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const avgGain = gains / Math.min(14, ph.length - 1);
    const avgLoss = losses / Math.min(14, ph.length - 1);
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    // Volume trend
    const recentVol = ph.slice(-5).reduce((s, h) => s + (h.v || 0), 0) / 5;
    const olderVol = ph.slice(0, Math.max(1, ph.length - 5)).reduce((s, h) => s + (h.v || 0), 0) / Math.max(1, ph.length - 5);
    const volTrend = recentVol > olderVol * 1.2 ? '<span class="ai-positive">放量</span>' : recentVol < olderVol * 0.8 ? '<span class="ai-warning">缩量</span>' : '平稳';

    // Price position in 24h range
    const range = last.h - last.l;
    const position = range > 0 ? ((last.p - last.l) / range * 100) : 50;

    let signal = '';
    if (rsi < 30) signal = '<span class="ai-positive">超卖信号，可考虑逢低买入</span>';
    else if (rsi > 70) signal = '<span class="ai-negative">超买信号，注意回调风险</span>';
    else if (rsi < 45) signal = '<span class="ai-warning">偏弱，短期可能继续探底</span>';
    else if (rsi > 55) signal = '<span class="ai-positive">偏强，短期趋势向好</span>';
    else signal = '中性区间，方向不明';

    sections.push(`<span class="ai-section-title">${c.symbol} — ${c.name}</span>
• 当前价格: ${fmt(last.p)}
• 24h 涨跌: ${last.c >= 0 ? '<span class="ai-positive">+' : '<span class="ai-negative">'}${last.c.toFixed(2)}%</span>
• 1分钟变化: ${change1m >= 0 ? '+' : ''}${change1m.toFixed(3)}%
• 价格位置: 区间的 ${position.toFixed(0)}%${position > 80 ? ' (接近高点)' : position < 20 ? ' (接近低点)' : ''}
• RSI 信号: ${rsi.toFixed(1)} — ${signal}
• 量能趋势: ${volTrend}
• 24h 成交额: ${fmtVol(last.v)}`);
  });

  sections.push(`<span class="ai-section-title">📊 综合评分</span>
基于以上技术指标，对各币种的短期（1-7天）看法：
${coins.map(c => {
    const ph = priceHistory[c.symbol];
    if (!ph || ph.length < 3) return `• ${c.symbol}: 数据不足`;
    const last = ph[ph.length - 1];
    let score = 50;
    if (last.c > 3) score += 15; else if (last.c > 0) score += 5; else if (last.c < -3) score -= 15; else score -= 5;
    // Volume factor
    const recentVol = ph.slice(-3).reduce((s, h) => s + (h.v || 0), 0) / 3;
    const olderVol = ph.slice(0, -3).reduce((s, h) => s + (h.v || 0), 0) / Math.max(1, ph.length - 3);
    if (recentVol > olderVol * 1.5 && last.c > 0) score += 10;
    if (recentVol > olderVol * 1.5 && last.c < 0) score -= 10;
    score = Math.max(10, Math.min(90, score));
    const emoji = score >= 70 ? '🟢' : score >= 40 ? '🟡' : '🔴';
    return `${emoji} ${c.symbol}: ${score}/100`;
  }).join('\n')}`);

  return sections.join('\n');
}

function generateEntryAnalysis() {
  if (!coins.length) return '<span class="ai-warning">⚠️ 请先添加自选币种后再进行分析。</span>';

  const sections = ['<span class="ai-section-title">🎯 入手区间建议 (基于量价分析)</span>\n'];

  coins.forEach(c => {
    const ph = priceHistory[c.symbol];
    if (!ph || ph.length < 5) {
      sections.push(`<span class="ai-section-title">${c.symbol}</span>\n• 数据不足，无法给出建议区间\n`);
      return;
    }

    const last = ph[ph.length - 1];
    const prices = ph.map(h => h.p).filter(p => p > 0);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min;
    const avg = prices.reduce((s, p) => s + p, 0) / prices.length;

    // Support / Resistance based on clustering
    const sortedPrices = [...prices].sort((a, b) => a - b);
    const q1 = sortedPrices[Math.floor(sortedPrices.length * 0.25)];
    const q3 = sortedPrices[Math.floor(sortedPrices.length * 0.75)];

    // Suggested entry zones
    const support1 = min + range * 0.15;
    const support2 = min + range * 0.05;
    const resistance1 = max - range * 0.15;
    const resistance2 = max - range * 0.05;

    let recommendation = '';
    if (last.p <= support1) {
      recommendation = '<span class="ai-positive">🟢 当前价格接近支撑区域，可以考虑建仓</span>';
    } else if (last.p >= resistance1) {
      recommendation = '<span class="ai-negative">🔴 当前价格接近阻力区域，建议等待回调</span>';
    } else {
      recommendation = '<span class="ai-warning">🟡 当前价格处于区间中部，可小仓位试探或等待更好位置</span>';
    }

    sections.push(`<span class="ai-section-title">${c.symbol} — ${c.name}</span>
• 当前价格: <span class="ai-price-range">${fmt(last.p)}</span>
• 24h 最低: ${fmt(min)} | 最高: ${fmt(max)}

<span class="ai-positive">支撑区间 (可分批买入):</span>
  第一支撑: <span class="ai-price-range">${fmt(support1)}</span> (轻仓试探)
  强支撑: <span class="ai-price-range">${fmt(support2)}</span> (加仓位置)

<span class="ai-negative">阻力区间 (注意止盈):</span>
  第一阻力: <span class="ai-price-range">${fmt(resistance1)}</span> (部分止盈)
  强阻力: <span class="ai-price-range">${fmt(resistance2)}</span> (大幅减仓)

${recommendation}

• 建议策略: ${last.p > avg ? '当前价格高于均值' + fmt(avg) + '，注意分批操作' : '当前价格低于均值' + fmt(avg) + '，有一定的安全边际'}
`);
  });

  sections.push(`<span class="ai-section-title">📌 分批建仓策略参考</span>
1. 首仓 (30%): 在第一支撑附近买入
2. 加仓 (30%): 在强支撑附近加仓
3. 预留 (40%): 应对极端行情的备用资金
• 每笔交易设置 5-8% 止损
• 盈利 15-20% 时分批止盈
• 不要一次性满仓，保持资金弹性`);

  return sections.join('\n');
}

function generateRiskAnalysis() {
  const sections = ['<span class="ai-section-title">⚠️ 风险评估报告</span>\n'];

  // Portfolio risk
  if (portfolio.length) {
    let totalCost = 0, totalValue = 0, totalExposure = 0;
    portfolio.forEach(p => {
      const ph = priceHistory[p.symbol];
      const last = ph?.length ? ph[ph.length - 1] : null;
      totalCost += p.buyPrice * p.qty;
      if (last) totalValue += last.p * p.qty;
      totalExposure += p.buyPrice * p.qty;
    });

    const pnlPct = totalCost > 0 ? ((totalValue - totalCost) / totalCost * 100) : 0;

    sections.push(`<span class="ai-section-title">💼 持仓风险分析</span>
• 总投入: ${fmt(totalCost)}
• 当前市值: ${totalValue ? fmt(totalValue) : '数据不足'}
• 盈亏: ${pnlPct >= 0 ? '<span class="ai-positive">+' : '<span class="ai-negative">'}${pnlPct.toFixed(2)}%</span>

${pnlPct < -10 ? '<span class="ai-negative">⚠️ 当前浮亏超过10%，建议评估是否需要止损或加仓摊薄成本。</span>' : ''}
${pnlPct > 20 ? '<span class="ai-positive">✅ 浮盈超过20%，建议分批止盈锁定部分利润。</span>' : ''}`);

    // Individual position risk
    sections.push('<span class="ai-section-title">📊 各持仓风险等级</span>');
    portfolio.forEach(p => {
      const ph = priceHistory[p.symbol];
      const last = ph?.length ? ph[ph.length - 1] : null;
      if (!last) { sections.push(`• ${p.symbol}: 数据不足`); return; }

      const pnl = ((last.p - p.buyPrice) / p.buyPrice * 100);
      const vol = last.v || 0;
      let riskLevel = '';

      if (pnl < -15) riskLevel = '<span class="ai-negative">高风险 (深度套牢)</span>';
      else if (pnl < -5) riskLevel = '<span class="ai-warning">中高风险 (小幅亏损)</span>';
      else if (pnl < 5) riskLevel = '中性 (微利微亏)';
      else if (pnl < 15) riskLevel = '<span class="ai-positive">低风险 (正常盈利)</span>';
      else riskLevel = '<span class="ai-positive">盈利丰厚 (考虑止盈)</span>';

      const stopLoss = p.buyPrice * 0.92;
      const takeProfit = p.buyPrice * 1.20;

      sections.push(`${p.symbol}: ${riskLevel}
  买入价: $${fmtRaw(p.buyPrice)} → 当前: ${fmt(last.p)} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%)
  建议止损: <span class="ai-price-range">${fmt(stopLoss)}</span> (${((stopLoss - last.p) / last.p * 100).toFixed(1)}%)
  建议止盈: <span class="ai-price-range">${fmt(takeProfit)}</span> (${((takeProfit - last.p) / last.p * 100).toFixed(1)}%)`);
    });
  } else {
    sections.push(`<span class="ai-section-title">💼 持仓风险分析</span>\n• 暂无持仓记录。添加持仓后可获得更精确的风险评估。\n• 点击 💰 按钮添加持仓信息。`);
  }

  // Market risk indicators
  const fearGreed = document.getElementById('fearGreed')?.textContent || '--';
  const mktChg = document.getElementById('mktChange')?.textContent || '--';
  const btcDom = document.getElementById('btcDom')?.textContent || '--';

  sections.push(`<span class="ai-section-title">🌐 市场风险指标</span>
• 恐惧贪婪指数: ${fearGreed}
• 24h 市场变化: ${mktChg}
• BTC 占比: ${btcDom}

<span class="ai-section-title">🛡️ 风控建议</span>
1. 单币种仓位不超过总资金的 25%
2. 保留至少 20% 的现金/稳定币作为缓冲
3. 设置止损单，不要心存侥幸
4. 杠杆控制在 3x 以内（新手建议 1x 现货）
5. 定期复盘，根据市场变化调整策略
6. 不要 FOMO 追涨，不要 FUD 杀跌
7. 极端行情（暴跌 >15%）时保持冷静，避免恐慌操作`);

  return sections.join('\n');
}

// ══════════════════════════════════════════════════════════════
// ── 强制预警 UI ──
// ══════════════════════════════════════════════════════════════

function openForceAlertModal() {
  // 填充币种下拉
  const sel = document.getElementById('forceAlertCoin');
  sel.innerHTML = coins.map(c => `<option value="${c.symbol}">${c.symbol} — ${c.name||''}</option>`).join('');
  renderForceAlertList();
  renderForceDropMonitor();
  document.getElementById('forceAlertModalOverlay').classList.add('active');
}
function closeForceAlertModal() {
  document.getElementById('forceAlertModalOverlay').classList.remove('active');
}

function renderForceAlertList() {
  const wrap = document.getElementById('forceAlertListWrap');
  const badge = document.getElementById('forceAlertBadge');
  const enabledCount = forceAlerts.filter(f => f.enabled).length;
  badge.textContent = enabledCount;
  badge.style.display = enabledCount > 0 ? '' : 'none';
  document.getElementById('forceAlertCount').textContent = forceAlerts.length + ' 条';

  if (!forceAlerts.length) {
    wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:0.8rem;">暂无强制预警</div>';
    return;
  }
  wrap.innerHTML = forceAlerts.map((fa, i) => {
    const snaps = forceAlertSnapshots[fa.symbol];
    let dropInfo = '';
    if (snaps && snaps.length >= 2) {
      const result = calcWindowDrop(fa.symbol, fa.windowMinutes);
      const dropColor = result.drop >= fa.dropPercent ? 'var(--red)' : result.drop >= fa.dropPercent * 0.6 ? '#e8a030' : 'var(--green)';
      dropInfo = `<span style="color:${dropColor};font-weight:600;font-size:0.72rem;">当前窗口跌幅: ${result.drop.toFixed(2)}%</span>`;
    } else {
      dropInfo = '<span style="color:var(--muted);font-size:0.72rem;">采样中…</span>';
    }
    const statusDot = fa.enabled ? '<span style="color:var(--green);">●</span>' : '<span style="color:var(--muted);">○</span>';
    const cooldownStr = fa.cooldownMs >= 60000 ? (fa.cooldownMs/60000)+'min' : (fa.cooldownMs/1000)+'s';
    return `<div class="alert-item ${fa.enabled ? '' : 'alert-item-disabled'}">
      <div class="alert-item-info">
        <div class="alert-item-symbol">${statusDot} ${fa.symbol} — 跌幅 ≥ ${fa.dropPercent}% / ${fa.windowMinutes}min</div>
        <div class="alert-item-condition">冷却: ${cooldownStr} | ${dropInfo}</div>
      </div>
      <div class="alert-item-actions">
        <button class="alert-item-btn" onclick="toggleForceAlert(${i})" title="${fa.enabled ? '暂停' : '启用'}">${fa.enabled ? '⏸️' : '▶️'}</button>
        <button class="alert-item-btn" onclick="removeForceAlert(${i})" title="删除">🗑️</button>
      </div>
    </div>`;
  }).join('');
}

function renderForceDropMonitor() {
  const section = document.getElementById('forceDropMonitor');
  const body = document.getElementById('forceDropMonitorBody');
  const activeFas = forceAlerts.filter(f => f.enabled);
  if (!activeFas.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  body.innerHTML = activeFas.map(fa => {
    const result = calcWindowDrop(fa.symbol, fa.windowMinutes);
    const pct = Math.min(100, (result.drop / fa.dropPercent) * 100);
    const barColor = pct >= 100 ? 'var(--red)' : pct >= 60 ? '#e8a030' : 'var(--green)';
    return `<div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:0.75rem;margin-bottom:3px;">
        <span>${fa.symbol} (窗口 ${fa.windowMinutes}min)</span>
        <span style="color:${barColor};font-weight:600;">${result.drop.toFixed(2)}% / ${fa.dropPercent}%</span>
      </div>
      <div style="background:var(--border);border-radius:4px;height:6px;overflow:hidden;">
        <div style="width:${pct}%;height:100%;background:${barColor};border-radius:4px;transition:width 0.5s ease;"></div>
      </div>
    </div>`;
  }).join('');
}

function addForceAlert() {
  const sym = document.getElementById('forceAlertCoin').value;
  const dropPct = parseFloat(document.getElementById('forceAlertDrop').value);
  const windowVal = parseInt(document.getElementById('forceAlertWindow').value);
  const windowUnit = document.getElementById('forceAlertWindowUnit').value;
  const cooldownVal = parseInt(document.getElementById('forceAlertCooldown').value);
  const cooldownUnit = document.getElementById('forceAlertCooldownUnit').value;

  if (!sym || isNaN(dropPct) || dropPct <= 0 || isNaN(windowVal) || windowVal <= 0) {
    showToast('请填写完整的预警参数', 'error');
    return;
  }

  const windowMinutes = windowUnit === 'h' ? windowVal * 60 : windowVal;
  const cooldownMs = cooldownUnit === 'm' ? cooldownVal * 60000 : cooldownVal * 1000;

  // 防重复
  if (forceAlerts.find(f => f.symbol === sym && f.windowMinutes === windowMinutes && f.dropPercent === dropPct)) {
    showToast(`${sym} 相同条件的强制预警已存在`, 'error');
    return;
  }

  forceAlerts.push({ symbol: sym, dropPercent: dropPct, windowMinutes, cooldownMs, enabled: true, lastTriggered: 0 });
  saveForceAlerts();
  syncForceMonitors();
  renderForceAlertList();
  renderForceDropMonitor();
  render(true); // 刷新主表预警标签
  showToast(`🚨 ${sym} 强制预警已添加: ${dropPct}% / ${windowMinutes}min`);
}

function removeForceAlert(i) {
  forceAlerts.splice(i, 1);
  saveForceAlerts();
  syncForceMonitors();
  renderForceAlertList();
  renderForceDropMonitor();
  render(true);
}

function toggleForceAlert(i) {
  forceAlerts[i].enabled = !forceAlerts[i].enabled;
  if (forceAlerts[i].enabled) forceAlerts[i].lastTriggered = 0; // 重置冷却
  saveForceAlerts();
  syncForceMonitors();
  renderForceAlertList();
  renderForceDropMonitor();
  render(true);
}

function applyForceWindowPreset(val) {
  if (!val) return;
  const m = val.match(/^(\d+)([mh])$/);
  if (!m) return;
  document.getElementById('forceAlertWindow').value = m[1];
  document.getElementById('forceAlertWindowUnit').value = m[2];
}

function applyForceCooldownPreset(val) {
  if (!val) return;
  const m = val.match(/^(\d+)([ms])$/);
  if (!m) return;
  document.getElementById('forceAlertCooldown').value = m[1];
  document.getElementById('forceAlertCooldownUnit').value = m[2];
}

function testForceAlertVoice() {
  if (!('speechSynthesis' in window)) {
    showToast('当前浏览器不支持语音合成', 'error');
    return;
  }
  forceSpeakAlert('强制预警测试！比特币在30分钟内暴跌5个百分点！从88000美元跌至83600美元！请注意风险！');
  playUrgentSound();
  showToast('🗣️ 强制预警语音测试已触发');
}

function exportForceAlerts() {
  if (!forceAlerts.length) { showToast('暂无强制预警可导出', 'error'); return; }
  const data = JSON.stringify({ forceAlerts }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'crypto-force-alerts-' + new Date().toISOString().slice(0,10) + '.json';
  a.click(); URL.revokeObjectURL(url);
  showToast('📤 强制预警已导出');
}

function importForceAlerts(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.forceAlerts && Array.isArray(data.forceAlerts)) {
        // 合并导入（去重）
        data.forceAlerts.forEach(nfa => {
          if (!forceAlerts.find(f => f.symbol === nfa.symbol && f.windowMinutes === nfa.windowMinutes && f.dropPercent === nfa.dropPercent)) {
            forceAlerts.push(nfa);
          }
        });
        saveForceAlerts();
        syncForceMonitors();
        renderForceAlertList();
        renderForceDropMonitor();
        render(true);
        showToast(`📥 已导入 ${data.forceAlerts.length} 条强制预警`);
      } else {
        showToast('导入文件格式无效', 'error');
      }
    } catch { showToast('导入文件解析失败', 'error'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// 定期刷新跌幅监控面板
setInterval(() => {
  if (document.getElementById('forceAlertModalOverlay').classList.contains('active')) {
    renderForceDropMonitor();
    renderForceAlertList();
  }
}, 15000);

// ══════════════════════════════════════════════════════════════
// ── Boot ──
// ══════════════════════════════════════════════════════════════
initSelects();
document.getElementById('soundToggle').textContent = soundEnabled ? '🔊' : '🔇';
document.getElementById('voiceToggle').textContent = voiceEnabled ? '🗣️' : '🔇';
document.getElementById('screenAlertToggle').textContent = screenAlertEnabled ? '💡' : '⬛';
document.getElementById('spellToggle').textContent = spellSymbols ? '🔤' : '🀄';
document.getElementById('spellToggle').title = spellSymbols ? '币种名称读法：逐字母拼读' : '币种名称读法：中文名称';
applyTheme();
applyColorInvert();
render();
binanceWsConnect();       // init WebSocket for major coins
fetchPrices();            // poll non-WS coins
timer = setInterval(fetchPrices, refreshSec * 1000);
fetchTrending();
fetchCurrencyRates();
fetchMarketOverview();
setInterval(fetchMarketOverview, 120000);
restoreNotifyToggleState();
syncForceMonitors(); // 启动强制预警监控

// ── Wake Lock（防止页面被完全冻结）──
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {}
}

// Wake Lock 由 Keepalive 系统的 visibilitychange/resume 统一管理
// 这里只做初始请求
requestWakeLock();

// 延迟初始化（避免阻塞首屏渲染）
setTimeout(showOnboarding, 1500);
setTimeout(requestNotificationPermission, 3000);

// ── iOS 键盘弹出时自动滚动聚焦元素到可视区域 ──
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) {
      setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100);
    }
  });
}
