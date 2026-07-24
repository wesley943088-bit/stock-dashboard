/**
 * stock-dashboard Yahoo Finance 代理 Worker
 *
 * 用途：
 *  1. /chart      直接轉送 Yahoo chart API（daily/weekly/monthly K 線），
 *                  避免前端依賴不穩定的公開 CORS proxy。
 *  2. /fundamentals 處理 Yahoo 的 cookie + crumb 驗證流程，
 *                  取得本益比、EPS、市值等真正的基本面資料。
 *
 * 部署：Cloudflare Workers（免費方案即可，不需要綁定 KV / D1）。
 * 用 in-memory 變數快取 cookie/crumb，同一個 isolate 存活期間重複使用，
 * 過期或失敗時會自動重新取得。
 */

const ALLOWED_ORIGINS = new Set([
  "https://wesley943088-bit.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

const CRUMB_TTL_MS = 20 * 60 * 1000; // 20 分鐘後強制重新取得

let crumbCache = { cookie: null, crumb: null, fetchedAt: 0 };

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, origin, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

async function fetchCookie() {
  const res = await fetch("https://fc.yahoo.com/", {
    redirect: "manual",
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("no set-cookie header from fc.yahoo.com");
  }
  // Cloudflare 的 fetch 只回傳合併後的單一 Set-Cookie 字串，取第一個 cookie pair 即可。
  return setCookie.split(";")[0];
}

async function fetchCrumb(cookie) {
  const res = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: {
      Cookie: cookie,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });
  const text = (await res.text()).trim();
  if (!text || text.includes("Too Many Requests") || text.startsWith("<")) {
    throw new Error(`invalid crumb response: ${text.slice(0, 120)}`);
  }
  return text;
}

async function getCrumb(forceRefresh = false) {
  const isFresh = Date.now() - crumbCache.fetchedAt < CRUMB_TTL_MS;
  if (!forceRefresh && isFresh && crumbCache.cookie && crumbCache.crumb) {
    return crumbCache;
  }
  const cookie = await fetchCookie();
  const crumb = await fetchCrumb(cookie);
  crumbCache = { cookie, crumb, fetchedAt: Date.now() };
  return crumbCache;
}

async function fetchQuoteSummary(symbol) {
  const modules = "price,summaryDetail,defaultKeyStatistics,financialData";
  let { cookie, crumb } = await getCrumb();

  let res = await fetchQuoteSummaryOnce(symbol, modules, cookie, crumb);

  if (res.status === 401 || res.status === 403) {
    // crumb 可能過期，強制刷新一次再試
    ({ cookie, crumb } = await getCrumb(true));
    res = await fetchQuoteSummaryOnce(symbol, modules, cookie, crumb);
  }

  if (!res.ok) {
    throw new Error(`quoteSummary http ${res.status}`);
  }
  const data = await res.json();
  if (data?.quoteSummary?.error) {
    throw new Error(data.quoteSummary.error.description || "quoteSummary error");
  }
  return data?.quoteSummary?.result?.[0] || null;
}

function fetchQuoteSummaryOnce(symbol, modules, cookie, crumb) {
  const url =
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  return fetch(url, {
    headers: {
      Cookie: cookie,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });
}

function pickRaw(obj) {
  if (obj && typeof obj === "object" && "raw" in obj) return obj.raw;
  return obj ?? null;
}

function extractFundamentals(result) {
  if (!result) return null;
  const price = result.price || {};
  const summaryDetail = result.summaryDetail || {};
  const keyStats = result.defaultKeyStatistics || {};
  const financialData = result.financialData || {};

  return {
    symbol: price.symbol ?? null,
    shortName: price.shortName ?? null,
    currency: price.currency ?? null,
    marketCap: pickRaw(price.marketCap),
    trailingPE: pickRaw(summaryDetail.trailingPE),
    forwardPE: pickRaw(summaryDetail.forwardPE),
    priceToBook: pickRaw(keyStats.priceToBook),
    trailingEps: pickRaw(keyStats.trailingEps),
    forwardEps: pickRaw(keyStats.forwardEps),
    dividendYield: pickRaw(summaryDetail.dividendYield),
    profitMargins: pickRaw(keyStats.profitMargins),
    revenueGrowth: pickRaw(financialData.revenueGrowth),
    earningsGrowth: pickRaw(financialData.earningsGrowth),
    returnOnEquity: pickRaw(financialData.returnOnEquity),
    debtToEquity: pickRaw(financialData.debtToEquity),
    targetMeanPrice: pickRaw(financialData.targetMeanPrice),
    recommendationKey: financialData.recommendationKey ?? null,
    fiftyTwoWeekHigh: pickRaw(summaryDetail.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: pickRaw(summaryDetail.fiftyTwoWeekLow),
  };
}

async function handleFundamentals(symbol, origin) {
  try {
    const result = await fetchQuoteSummary(symbol);
    const data = extractFundamentals(result);
    if (!data) {
      return jsonResponse({ error: "no data" }, origin, 404);
    }
    return jsonResponse(data, origin);
  } catch (err) {
    return jsonResponse({ error: String(err.message || err) }, origin, 502);
  }
}

async function handleChart(symbol, range, interval, origin) {
  const url =
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    const data = await res.json();
    return jsonResponse(data, origin, res.status);
  } catch (err) {
    return jsonResponse({ error: String(err.message || err) }, origin, 502);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (url.pathname === "/fundamentals") {
      const symbol = url.searchParams.get("symbol");
      if (!symbol) return jsonResponse({ error: "missing symbol" }, origin, 400);
      return handleFundamentals(symbol, origin);
    }

    if (url.pathname === "/chart") {
      const symbol = url.searchParams.get("symbol");
      const range = url.searchParams.get("range") || "6mo";
      const interval = url.searchParams.get("interval") || "1d";
      if (!symbol) return jsonResponse({ error: "missing symbol" }, origin, 400);
      return handleChart(symbol, range, interval, origin);
    }

    if (url.pathname === "/" || url.pathname === "") {
      return jsonResponse(
        {
          ok: true,
          endpoints: ["/chart?symbol=AAPL&range=6mo&interval=1d", "/fundamentals?symbol=AAPL"],
        },
        origin
      );
    }

    return jsonResponse({ error: "not found" }, origin, 404);
  },
};
