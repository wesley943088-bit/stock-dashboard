const DATA_URL = "./data/market-data.json";
const STORAGE_KEY = "stock-dashboard:addedSymbols";
const MARKET_INDEX_SYMBOL = "^GSPC";
const MARKET_INDEX_LABEL = "S&P 500";

// Yahoo Finance's chart API does not send CORS headers for arbitrary origins,
// so a direct browser fetch from a page hosted elsewhere will fail. We try a
// direct fetch first (in case it's ever allowed) and fall back to public CORS
// proxies so typing a brand-new symbol, or switching to a weekly/monthly
// timeframe, can pull real data on the spot.
const CORS_PROXIES = [
  (url) => url,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
];

// Per-timeframe fetch config. Weekly/monthly need a longer range so there is
// enough history for the 9/3/3 KD warm-up plus 30 chart points.
const TIMEFRAME_CONFIG = {
  daily: { interval: "1d", range: "6mo", limit: 90, label: "日線", chartLabel: "近 30 筆日線資料" },
  weekly: { interval: "1wk", range: "5y", limit: 104, label: "週線", chartLabel: "近 30 筆週線資料" },
  monthly: { interval: "1mo", range: "10y", limit: 60, label: "月線", chartLabel: "近 30 筆月線資料" },
};

const state = {
  data: null,
  currentSymbol: null,
  currentTimeframe: "daily",
  visibleSymbols: [],
  market: { status: "loading", trend: null, note: "" },
};

const els = {
  generatedAt: document.querySelector("#generatedAt"),
  sourceName: document.querySelector("#sourceName"),
  symbolSelect: document.querySelector("#symbolSelect"),
  timeframeSelect: document.querySelector("#timeframeSelect"),
  addSymbolForm: document.querySelector("#addSymbolForm"),
  symbolInput: document.querySelector("#symbolInput"),
  addSymbolBtn: document.querySelector("#addSymbolBtn"),
  volumeThreshold: document.querySelector("#volumeThreshold"),
  kdHigh: document.querySelector("#kdHigh"),
  kdLow: document.querySelector("#kdLow"),
  latestClose: document.querySelector("#latestClose"),
  latestVolume: document.querySelector("#latestVolume"),
  latestKd: document.querySelector("#latestKd"),
  latestVolumeChange: document.querySelector("#latestVolumeChange"),
  chartTitle: document.querySelector("#chartTitle"),
  chartSubtitle: document.querySelector("#chartSubtitle"),
  signalBadge: document.querySelector("#signalBadge"),
  priceChart: document.querySelector("#priceChart"),
  alertsList: document.querySelector("#alertsList"),
  addHint: document.querySelector("#addHint"),
  dataRows: document.querySelector("#dataRows"),
  suggestionBadge: document.querySelector("#suggestionBadge"),
  suggestionTitle: document.querySelector("#suggestionTitle"),
  suggestionBody: document.querySelector("#suggestionBody"),
  marketTrend: document.querySelector("#marketTrend"),
  valuationContext: document.querySelector("#valuationContext"),
  riskContext: document.querySelector("#riskContext"),
};

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return new Intl.NumberFormat("zh-TW", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function formatInteger(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 }).format(value);
}

function formatPct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value, 2)}%`;
}

function setClassBySign(node, value) {
  node.classList.remove("up", "down");
  if (value > 0) node.classList.add("up");
  if (value < 0) node.classList.add("down");
}

function setHint(text, kind) {
  els.addHint.textContent = text;
  els.addHint.classList.remove("error", "success");
  if (kind) els.addHint.classList.add(kind);
}

function getThresholds() {
  return {
    volume: Number(els.volumeThreshold.value || 15),
    kdHigh: Number(els.kdHigh.value || 80),
    kdLow: Number(els.kdLow.value || 20),
  };
}

function getSelectedPayload() {
  return state.data.symbols[state.currentSymbol];
}

function getRowsForTimeframe(payload, timeframe) {
  if (!payload) return null;
  if (timeframe === "daily") return payload.rows || null;
  return (payload.timeframes && payload.timeframes[timeframe]) || null;
}

function latestRows(rows, count) {
  return rows.filter((row) => row.k !== null && row.d !== null).slice(-count);
}

function buildAlerts(latest) {
  const thresholds = getThresholds();
  const alerts = [];

  if (Math.abs(latest.volumeChangePct || 0) >= thresholds.volume) {
    alerts.push({
      level: latest.volumeChangePct > 0 ? "warning" : "danger",
      title: `成交量變化 ${formatPct(latest.volumeChangePct)}`,
      body: `相對近 5 期均量 ${formatInteger(latest.volumeMA5)}，已超過 ${thresholds.volume}% 門檻。`,
    });
  }

  if (latest.k >= thresholds.kdHigh || latest.d >= thresholds.kdHigh) {
    alerts.push({
      level: "warning",
      title: "KD 進入高檔區",
      body: `K=${formatNumber(latest.k)}, D=${formatNumber(latest.d)}，高於 ${thresholds.kdHigh} 需留意鈍化或反轉。`,
    });
  }

  if (latest.k <= thresholds.kdLow || latest.d <= thresholds.kdLow) {
    alerts.push({
      level: "danger",
      title: "KD 跌入低檔區",
      body: `K=${formatNumber(latest.k)}, D=${formatNumber(latest.d)}，低於 ${thresholds.kdLow} 需留意弱勢延續或反彈。`,
    });
  }

  if (latest.k > latest.d && latest.kChange > 0) {
    alerts.push({
      level: "ok",
      title: "KD 短線偏多",
      body: `K 高於 D，且 K 較前一期增加 ${formatNumber(latest.kChange)}。`,
    });
  } else if (latest.k < latest.d && latest.kChange < 0) {
    alerts.push({
      level: "danger",
      title: "KD 短線偏弱",
      body: `K 低於 D，且 K 較前一期下降 ${formatNumber(Math.abs(latest.kChange))}。`,
    });
  }

  return alerts;
}

// ---- Rule-based buy/sell suggestion (KD golden/death cross + market filter) ----
// This is a mechanical technical-indicator signal only. It is not investment
// advice, does not account for a company's fundamentals in depth, your
// position size, or your personal risk tolerance. False signals are common
// in choppy markets — treat it as one input among many, not a recommendation
// to act on.

function buildSuggestion(rows) {
  const thresholds = getThresholds();
  const recent = latestRows(rows, 2);

  if (recent.length < 2) {
    return { signal: "hold", title: "資料不足", body: "近期資料不足以判斷 KD 交叉。" };
  }

  const [prev, latest] = recent;
  const goldenCross = prev.k <= prev.d && latest.k > latest.d;
  const deathCross = prev.k >= prev.d && latest.k < latest.d;
  const volumeConfirm = (latest.volumeChangePct || 0) >= thresholds.volume;
  const volumeFade = (latest.volumeChangePct || 0) <= -thresholds.volume;
  const volumeNote = volumeConfirm
    ? "成交量同步放大，訊號較有支撐。"
    : volumeFade
    ? "但成交量同步萎縮，訊號力道較弱。"
    : "";

  const marketTrend = state.market.trend;
  const marketNoteFor = (direction) => {
    if (marketTrend === null) return "";
    if (direction === "buy") {
      return marketTrend === "bull"
        ? `大盤（${MARKET_INDEX_LABEL}）同步偏多，訊號較有支撐。`
        : `但大盤（${MARKET_INDEX_LABEL}）目前偏空，逆勢操作風險較高，訊號可信度較低。`;
    }
    return marketTrend === "bear"
      ? `大盤（${MARKET_INDEX_LABEL}）同步偏空，訊號較有支撐。`
      : `但大盤（${MARKET_INDEX_LABEL}）目前偏多，逆勢操作風險較高，訊號可信度較低。`;
  };

  if (goldenCross) {
    const strong = latest.k <= thresholds.kdLow || latest.d <= thresholds.kdLow;
    return {
      signal: "buy",
      title: strong ? "偏多訊號：低檔黃金交叉" : "偏多訊號：黃金交叉",
      body: `K 由 ${formatNumber(prev.k)} 上穿 D（D：${formatNumber(prev.d)} → ${formatNumber(latest.d)}）。${volumeNote} ${marketNoteFor(
        "buy"
      )}`.trim(),
    };
  }

  if (deathCross) {
    const strong = latest.k >= thresholds.kdHigh || latest.d >= thresholds.kdHigh;
    return {
      signal: "sell",
      title: strong ? "偏空訊號：高檔死亡交叉" : "偏空訊號：死亡交叉",
      body: `K 由 ${formatNumber(prev.k)} 下穿 D（D：${formatNumber(prev.d)} → ${formatNumber(latest.d)}）。${volumeNote} ${marketNoteFor(
        "sell"
      )}`.trim(),
    };
  }

  return {
    signal: "hold",
    title: "觀望：無交叉訊號",
    body: `最新 K=${formatNumber(latest.k)}, D=${formatNumber(latest.d)}，未偵測到黃金或死亡交叉。`,
  };
}

function renderSuggestion(rows) {
  const suggestion = buildSuggestion(rows);
  els.suggestionBadge.className = "badge";
  const labels = { buy: "建議買進", sell: "建議賣出", hold: "觀望" };
  const badgeClass = { buy: "success", sell: "danger", hold: "" };
  els.suggestionBadge.textContent = labels[suggestion.signal];
  if (badgeClass[suggestion.signal]) els.suggestionBadge.classList.add(badgeClass[suggestion.signal]);
  els.suggestionTitle.textContent = suggestion.title;
  els.suggestionTitle.className = `suggestion-title ${suggestion.signal}`;
  els.suggestionBody.textContent = suggestion.body;
}

function renderMarketContext() {
  if (state.market.status === "loading") {
    els.marketTrend.textContent = "載入中…";
    return;
  }
  if (state.market.status === "error") {
    els.marketTrend.textContent = "無法取得大盤資料";
    return;
  }
  const label = state.market.trend === "bull" ? "偏多" : "偏空";
  els.marketTrend.textContent = `${label}（現價 ${state.market.trend === "bull" ? "高於" : "低於"} 20 期均線 ${formatPct(
    state.market.pct
  )}）`;
}

function renderValuationContext(payload) {
  const high = payload && payload.fiftyTwoWeekHigh;
  const low = payload && payload.fiftyTwoWeekLow;
  const rows = payload && payload.rows;
  const latestDaily = rows ? latestRows(rows, 1)[0] : null;
  if (!high || !low || !latestDaily || high === low) {
    els.valuationContext.textContent = "載入中…";
    return;
  }
  const pos = ((latestDaily.close - low) / (high - low)) * 100;
  els.valuationContext.textContent = `位於區間 ${formatNumber(pos, 0)}%（低 ${formatNumber(low)} / 高 ${formatNumber(high)}）`;
}

function computeRisk(rows) {
  const sample = latestRows(rows, 14).filter((row) => row.high != null && row.low != null && row.close);
  if (!sample.length) return null;
  const avgRangePct = sample.reduce((sum, row) => sum + Math.abs(row.high - row.low) / row.close, 0) / sample.length;
  const swingSample = latestRows(rows, 20);
  const swingLow = Math.min(...swingSample.map((row) => row.low).filter((v) => v != null));
  const swingHigh = Math.max(...swingSample.map((row) => row.high).filter((v) => v != null));
  return { avgRangePct: avgRangePct * 100, swingLow, swingHigh };
}

function renderRiskContext(rows) {
  const risk = computeRisk(rows);
  if (!risk) {
    els.riskContext.textContent = "--";
    return;
  }
  els.riskContext.textContent = `日均波動 ${formatNumber(risk.avgRangePct, 1)}%，近期區間 ${formatNumber(
    risk.swingLow
  )} ~ ${formatNumber(risk.swingHigh)}`;
}

function renderSummary(payload, latest) {
  const tfLabel = TIMEFRAME_CONFIG[state.currentTimeframe].label;
  els.chartTitle.textContent = `${payload.symbol} ${payload.name || ""}`.trim();
  els.chartSubtitle.textContent = TIMEFRAME_CONFIG[state.currentTimeframe].chartLabel;
  els.latestClose.textContent = `${formatNumber(latest.close)} ${payload.currency || "USD"}`;
  els.latestVolume.textContent = formatInteger(latest.volume);
  els.latestKd.textContent = `${formatNumber(latest.k)} / ${formatNumber(latest.d)}`;
  els.latestVolumeChange.textContent = formatPct(latest.volumeChangePct);
  setClassBySign(els.latestVolumeChange, latest.volumeChangePct);

  els.signalBadge.className = "badge";
  els.signalBadge.textContent = `${tfLabel}｜${latest.k > latest.d ? "K > D" : "K < D"}`;
  if (latest.k <= latest.d) els.signalBadge.classList.add("warning");
}

function renderAlerts(latest) {
  const alerts = buildAlerts(latest);
  els.alertsList.innerHTML = "";
  for (const alert of alerts) {
    const item = document.createElement("li");
    item.className = alert.level === "ok" ? "" : alert.level;
    item.innerHTML = `<strong>${alert.title}</strong><span>${alert.body}</span>`;
    els.alertsList.appendChild(item);
  }
}

function renderTable(rows) {
  els.dataRows.innerHTML = "";
  for (const row of latestRows(rows, 5)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.date}</td>
      <td>${formatNumber(row.close)}</td>
      <td>${formatInteger(row.volume)}</td>
      <td>${formatNumber(row.k)}</td>
      <td>${formatNumber(row.d)}</td>
      <td class="${row.kChange >= 0 ? "up" : "down"}">${row.kChange >= 0 ? "+" : ""}${formatNumber(row.kChange)}</td>
      <td class="${row.dChange >= 0 ? "up" : "down"}">${row.dChange >= 0 ? "+" : ""}${formatNumber(row.dChange)}</td>
      <td class="${row.volumeChangePct >= 0 ? "up" : "down"}">${formatPct(row.volumeChangePct)}</td>
    `;
    els.dataRows.appendChild(tr);
  }
}

function scale(value, min, max, start, end) {
  if (max === min) return (start + end) / 2;
  return start + ((value - min) / (max - min)) * (end - start);
}

function pathFor(rows, key, xFor, yFor) {
  return rows
    .filter((row) => row[key] !== null)
    .map((row, index) => `${index === 0 ? "M" : "L"} ${xFor(row)} ${yFor(row[key])}`)
    .join(" ");
}

function renderChart(rows) {
  const chartRows = latestRows(rows, 30);
  const svg = els.priceChart;
  const width = 900;
  const height = 410;
  const pad = { top: 24, right: 42, bottom: 46, left: 58 };
  const split = 230;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";

  const prices = chartRows.map((row) => row.close);
  const volumes = chartRows.map((row) => row.volume);
  const minPrice = Math.min(...prices) * 0.995;
  const maxPrice = Math.max(...prices) * 1.005;
  const maxVolume = Math.max(...volumes);
  const x = (index) => scale(index, 0, Math.max(chartRows.length - 1, 1), pad.left, width - pad.right);
  const yPrice = (value) => scale(value, minPrice, maxPrice, split, pad.top);
  const yKd = (value) => scale(value, 0, 100, height - pad.bottom, split + 28);
  const yVolume = (value) => scale(value, 0, maxVolume, height - pad.bottom, split + 105);

  for (const y of [pad.top, 78, 132, split, split + 74, height - pad.bottom]) {
    svg.insertAdjacentHTML("beforeend", `<line class="grid" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}"></line>`);
  }

  const barWidth = Math.max(4, (width - pad.left - pad.right) / chartRows.length - 5);
  chartRows.forEach((row, index) => {
    const barHeight = height - pad.bottom - yVolume(row.volume);
    svg.insertAdjacentHTML(
      "beforeend",
      `<rect class="bar" x="${x(index) - barWidth / 2}" y="${yVolume(row.volume)}" width="${barWidth}" height="${barHeight}"></rect>`
    );
  });

  const pricePath = pathFor(chartRows, "close", (row) => x(chartRows.indexOf(row)), yPrice);
  const kPath = pathFor(chartRows, "k", (row) => x(chartRows.indexOf(row)), yKd);
  const dPath = pathFor(chartRows, "d", (row) => x(chartRows.indexOf(row)), yKd);

  svg.insertAdjacentHTML("beforeend", `<path class="price-line" d="${pricePath}"></path>`);
  svg.insertAdjacentHTML("beforeend", `<path class="k-line" d="${kPath}"></path>`);
  svg.insertAdjacentHTML("beforeend", `<path class="d-line" d="${dPath}"></path>`);
  svg.insertAdjacentHTML("beforeend", `<line class="axis" x1="${pad.left}" y1="${split}" x2="${width - pad.right}" y2="${split}"></line>`);
  svg.insertAdjacentHTML("beforeend", `<line class="axis" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}"></line>`);
  svg.insertAdjacentHTML("beforeend", `<text class="legend" x="${pad.left}" y="18">收盤價</text>`);
  svg.insertAdjacentHTML("beforeend", `<text class="legend" x="${pad.left}" y="${split + 22}">KD 與成交量</text>`);
  svg.insertAdjacentHTML("beforeend", `<text class="chart-label" x="${width - pad.right - 56}" y="18">Price</text>`);
  svg.insertAdjacentHTML("beforeend", `<text class="chart-label" x="${width - pad.right - 46}" y="${split + 22}">K / D</text>`);

  const first = chartRows[0];
  const last = chartRows[chartRows.length - 1];
  svg.insertAdjacentHTML("beforeend", `<text class="chart-label" x="${pad.left}" y="${height - 16}">${first.date}</text>`);
  svg.insertAdjacentHTML("beforeend", `<text class="chart-label" text-anchor="end" x="${width - pad.right}" y="${height - 16}">${last.date}</text>`);
}

async function renderSymbol() {
  const payload = getSelectedPayload();
  if (!payload) return;

  const timeframe = state.currentTimeframe;
  let rows = getRowsForTimeframe(payload, timeframe);

  if (!rows) {
    els.chartTitle.textContent = `${payload.symbol} 載入${TIMEFRAME_CONFIG[timeframe].label}資料中…`;
    try {
      rows = await ensureTimeframe(state.currentSymbol, timeframe);
    } catch (err) {
      els.chartTitle.textContent = `${payload.symbol}：載入${TIMEFRAME_CONFIG[timeframe].label}資料失敗`;
      setHint(`載入 ${payload.symbol} 的${TIMEFRAME_CONFIG[timeframe].label}資料失敗：${err.message || err}`, "error");
      return;
    }
  }

  if (state.currentSymbol !== payload.symbol || state.currentTimeframe !== timeframe) return; // stale response
  if (!rows || !rows.length) return;

  const latest = latestRows(rows, 1)[0];
  renderSummary(payload, latest);
  renderSuggestion(rows);
  renderMarketContext();
  renderValuationContext(payload);
  renderRiskContext(rows);
  renderAlerts(latest);
  renderTable(rows);
  renderChart(rows);

  if (!payload.fiftyTwoWeekHigh || !payload.fiftyTwoWeekLow) backfillFiftyTwoWeek(payload);
}

// Pre-baked default symbols ship without 52-week meta (only computed rows).
// Fetch it once, lazily, in the background so the valuation context card
// fills in without blocking the initial render.
let backfillInFlight = new Set();
async function backfillFiftyTwoWeek(payload) {
  if (backfillInFlight.has(payload.symbol)) return;
  backfillInFlight.add(payload.symbol);
  try {
    const { meta } = await fetchChart(payload.symbol, TIMEFRAME_CONFIG.daily);
    if (meta.fiftyTwoWeekHigh) payload.fiftyTwoWeekHigh = meta.fiftyTwoWeekHigh;
    if (meta.fiftyTwoWeekLow) payload.fiftyTwoWeekLow = meta.fiftyTwoWeekLow;
    if (state.currentSymbol === payload.symbol) renderValuationContext(payload);
  } catch {
    // best-effort only; leave the "no data yet" message in place
  } finally {
    backfillInFlight.delete(payload.symbol);
  }
}

function hydrateSymbolSelect() {
  els.symbolSelect.innerHTML = "";
  for (const symbol of state.visibleSymbols) {
    const option = document.createElement("option");
    option.value = symbol;
    option.textContent = symbol;
    els.symbolSelect.appendChild(option);
  }
  els.symbolSelect.value = state.currentSymbol;
}

// ---- KD / volume indicator math (mirrors scripts/fetch_market_data.py) ----

function round4(value) {
  if (value === null || value === undefined || Number.isNaN(value) || !Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

function rollingMin(arr, window) {
  return arr.map((_, i) => {
    if (i < window - 1) return null;
    const slice = arr.slice(i - window + 1, i + 1);
    if (slice.some((x) => x === null || x === undefined)) return null;
    return Math.min(...slice);
  });
}

function rollingMax(arr, window) {
  return arr.map((_, i) => {
    if (i < window - 1) return null;
    const slice = arr.slice(i - window + 1, i + 1);
    if (slice.some((x) => x === null || x === undefined)) return null;
    return Math.max(...slice);
  });
}

function rollingMean(arr, window) {
  return arr.map((_, i) => {
    if (i < window - 1) return null;
    const slice = arr.slice(i - window + 1, i + 1);
    if (slice.some((x) => x === null || x === undefined)) return null;
    return slice.reduce((a, b) => a + b, 0) / window;
  });
}

function diffArr(arr) {
  return arr.map((v, i) => {
    if (i === 0) return null;
    if (v === null || arr[i - 1] === null) return null;
    return v - arr[i - 1];
  });
}

function computeIndicatorRows(rawRows) {
  const lows = rawRows.map((r) => r.low);
  const highs = rawRows.map((r) => r.high);
  const closes = rawRows.map((r) => r.close);
  const volumes = rawRows.map((r) => r.volume);

  const lowN = rollingMin(lows, 9);
  const highN = rollingMax(highs, 9);
  const rsv = closes.map((c, i) => {
    if (lowN[i] === null || highN[i] === null) return null;
    const denom = highN[i] - lowN[i];
    if (denom === 0) return null;
    return ((c - lowN[i]) / denom) * 100;
  });
  const k = rollingMean(rsv, 3);
  const d = rollingMean(k, 3);
  const kChange = diffArr(k);
  const dChange = diffArr(d);
  const volumeMA5 = rollingMean(volumes, 5);
  const volumeChangePct = volumes.map((v, i) => {
    if (volumeMA5[i] === null || volumeMA5[i] === 0) return null;
    return ((v - volumeMA5[i]) / volumeMA5[i]) * 100;
  });

  return rawRows.map((r, i) => ({
    date: r.date,
    open: round4(r.open),
    high: round4(r.high),
    low: round4(r.low),
    close: round4(r.close),
    volume: Math.round(r.volume),
    k: round4(k[i]),
    d: round4(d[i]),
    kChange: round4(kChange[i]),
    dChange: round4(dChange[i]),
    volumeMA5: round4(volumeMA5[i]),
    volumeChangePct: round4(volumeChangePct[i]),
  }));
}

// ---- Live fetch (any symbol, any timeframe) ----

async function fetchViaProxies(url) {
  let lastError = null;
  for (const wrap of CORS_PROXIES) {
    try {
      const res = await fetch(wrap(url), { headers: { Accept: "application/json" } });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("所有連線方式都失敗");
}

async function fetchChart(symbol, timeframeConfig) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${timeframeConfig.range}&interval=${timeframeConfig.interval}`;
  const json = await fetchViaProxies(url);
  const chartError = json && json.chart && json.chart.error;
  if (chartError) throw new Error(chartError.description || "查無此股票代號");
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error("查無此股票代號");

  const meta = result.meta || {};
  const ts = result.timestamp || [];
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};

  const rawRows = [];
  for (let i = 0; i < ts.length; i++) {
    const o = quote.open && quote.open[i];
    const h = quote.high && quote.high[i];
    const l = quote.low && quote.low[i];
    const c = quote.close && quote.close[i];
    const v = quote.volume && quote.volume[i];
    if (o == null || h == null || l == null || c == null || v == null) continue;
    const dateStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ts[i] * 1000));
    rawRows.push({ date: dateStr, open: o, high: h, low: l, close: c, volume: v });
  }
  if (!rawRows.length) throw new Error("查無此股票代號的資料");

  const fullRows = computeIndicatorRows(rawRows);
  const rows = fullRows.slice(Math.max(0, fullRows.length - timeframeConfig.limit));

  return { meta, rows };
}

async function fetchLiveSymbol(symbol) {
  const { meta, rows } = await fetchChart(symbol, TIMEFRAME_CONFIG.daily);
  return {
    symbol,
    name: meta.shortName || meta.longName || symbol,
    currency: meta.currency || "USD",
    exchange: meta.fullExchangeName || meta.exchangeName,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
    rows,
    timeframes: {},
  };
}

// Ensures payload.rows (daily) / payload.timeframes[tf] (weekly, monthly) is
// populated for the given symbol+timeframe, fetching live if needed. Also
// opportunistically backfills the 52-week high/low used for the valuation
// context card, since pre-baked default symbols don't carry it yet.
async function ensureTimeframe(symbol, timeframe) {
  const payload = state.data.symbols[symbol];
  const existing = getRowsForTimeframe(payload, timeframe);
  if (existing) return existing;

  const { meta, rows } = await fetchChart(symbol, TIMEFRAME_CONFIG[timeframe]);
  if (!payload.fiftyTwoWeekHigh && meta.fiftyTwoWeekHigh) payload.fiftyTwoWeekHigh = meta.fiftyTwoWeekHigh;
  if (!payload.fiftyTwoWeekLow && meta.fiftyTwoWeekLow) payload.fiftyTwoWeekLow = meta.fiftyTwoWeekLow;

  if (timeframe === "daily") {
    payload.rows = rows;
  } else {
    payload.timeframes = payload.timeframes || {};
    payload.timeframes[timeframe] = rows;
  }
  return rows;
}

async function refreshMarketTrend() {
  try {
    const { rows } = await fetchChart(MARKET_INDEX_SYMBOL, TIMEFRAME_CONFIG.daily);
    const closes = rows.map((r) => r.close).filter((v) => v != null);
    const sample = closes.slice(-20);
    if (!sample.length) throw new Error("no data");
    const sma20 = sample.reduce((a, b) => a + b, 0) / sample.length;
    const lastClose = closes[closes.length - 1];
    const pct = ((lastClose - sma20) / sma20) * 100;
    state.market = { status: "ready", trend: lastClose >= sma20 ? "bull" : "bear", pct };
  } catch (err) {
    state.market = { status: "error", trend: null, pct: null };
  }
  renderMarketContext();
  renderSymbol();
}

function loadStoredSymbols() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistStoredSymbol(symbol, payload) {
  const stored = loadStoredSymbols();
  stored[symbol] = payload;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // storage full or unavailable — ignore, symbol still works for this session
  }
}

async function addSymbol(rawSymbol) {
  const symbol = rawSymbol.trim().toUpperCase();
  if (!symbol) return;

  if (state.data.symbols[symbol]) {
    state.currentSymbol = symbol;
    if (!state.visibleSymbols.includes(symbol)) state.visibleSymbols.push(symbol);
    hydrateSymbolSelect();
    renderSymbol();
    setHint(`${symbol} 已在觀察清單中。`, null);
    return;
  }

  els.addSymbolBtn.disabled = true;
  els.addSymbolBtn.textContent = "查詢中…";
  setHint(`正在即時抓取 ${symbol} 的日線資料…`, null);

  try {
    const payload = await fetchLiveSymbol(symbol);
    state.data.symbols[symbol] = payload;
    state.visibleSymbols.push(symbol);
    state.currentSymbol = symbol;
    state.currentTimeframe = "daily";
    els.timeframeSelect.value = "daily";
    persistStoredSymbol(symbol, payload);
    hydrateSymbolSelect();
    renderSymbol();
    setHint(`${symbol} 已即時加入儀表板（資料來源：Yahoo Finance）。`, "success");
  } catch (err) {
    setHint(`找不到 ${symbol}：${err.message || err}。請確認是否為有效的美股代號。`, "error");
  } finally {
    els.addSymbolBtn.disabled = false;
    els.addSymbolBtn.textContent = "加入";
  }
}

function renderPrivateCompanies() {
  const companies = state.data.privateCompanies || [];
  if (!companies.length) return;
  const names = companies.map((company) => company.name).join("、");
  setHint(`${names} 目前未上市，沒有公開美股代號，無法取得成交量與 KD。`, null);
}

async function init() {
  const response = await fetch(DATA_URL, { cache: "no-store" });
  state.data = await response.json();

  // Merge in any symbols the user previously added live in this browser.
  const stored = loadStoredSymbols();
  for (const [symbol, payload] of Object.entries(stored)) {
    if (!state.data.symbols[symbol]) state.data.symbols[symbol] = payload;
  }
  for (const payload of Object.values(state.data.symbols)) {
    if (!payload.timeframes) payload.timeframes = {};
  }

  state.visibleSymbols = Object.keys(state.data.symbols);
  state.currentSymbol = state.visibleSymbols[0];
  hydrateSymbolSelect();
  els.generatedAt.textContent = `更新時間 UTC ${state.data.generatedAt || "--"}`;
  els.sourceName.textContent = state.data.source || "";
  renderPrivateCompanies();
  renderSymbol();
  refreshMarketTrend();
}

els.symbolSelect.addEventListener("change", (event) => {
  state.currentSymbol = event.target.value;
  renderSymbol();
});

els.timeframeSelect.addEventListener("change", (event) => {
  state.currentTimeframe = event.target.value;
  renderSymbol();
});

els.addSymbolForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = els.symbolInput.value;
  els.symbolInput.value = "";
  addSymbol(value);
});

for (const input of [els.volumeThreshold, els.kdHigh, els.kdLow]) {
  input.addEventListener("input", renderSymbol);
}

init().catch((error) => {
  document.body.innerHTML = `<main class="shell"><section class="panel"><h1>資料載入失敗</h1><p>${error.message}</p></section></main>`;
});
