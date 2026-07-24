# 美股成交量與 KD 監控 Dashboard

這是一個可部署到 GitHub Pages 的靜態儀表板，用來追蹤美股成交量、KD 指標，以及簡單示警條件。
（複製自 https://589411.github.io/stock-dashboard/ ，並把「新增觀察」改成真的能即時抓取任意美股代號。）

## 功能

- 顯示最近 5 個交易日的收盤價、成交量、K、D、K/D 變化。
- 視覺化近 30 筆日線資料，包含收盤價、成交量、K 線與 D 線。
- 示警條件：
  - 成交量相對近 5 日均量變化超過 15%。
  - K 或 D 高於 80。
  - K 或 D 低於 20。
- 支援多股票觀察清單，預設含 MU、GOOGL、NVDA、AMD、TSM、AAPL。
- **輸入任意美股代號並按「加入」，前端會即時向 Yahoo Finance 抓取日線資料、
  在瀏覽器內計算 KD 與量能指標，馬上顯示在儀表板上**（不需要重新產生 JSON 或
  重新部署）。這份即時抓取會透過公開 CORS proxy 轉送請求，若 proxy 服務當機，
  該次查詢會失敗並顯示錯誤訊息，但不影響既有股票的顯示。
- 即時加入的股票代號會存在瀏覽器的 localStorage，重新整理頁面後仍會保留。
- 未上市公司可保留在設定檔註記，但不會產生日線成交量與 KD。
- 支援台股：新增觀察時可直接輸入純數字代號（例如 2330），前端會自動先試
  `.TW`（上市），失敗再試 `.TWO`（上櫃）；也可以自己輸入完整代號如
  `2330.TW`。台股的大盤環境卡片會自動改用台股加權指數（^TWII），而不是
  S&P 500，交易日期也會照掛牌交易所的時區換算，不會沿用美股的美東時間。
- 基本面資料（本益比、EPS、市值、殖利率）透過 `worker/worker.js` 這個
  Cloudflare Worker 取得。Yahoo 的 `quoteSummary` API 需要 cookie +
  crumb 驗證，純前端頁面拿不到，所以由這個小後端代為處理驗證流程再把資料轉送回來；
  同一個 Worker 也順便取代了原本不穩定的公開 CORS proxy 做為 K 線資料的主要來源。
  部署方式見下方「後端部署（Cloudflare Worker）」。若不部署這個 Worker，網站其餘功能
  （K 線、KD、示警、建議）仍可正常運作，只是基本面卡片會顯示「尚未設定後端」。

## 本機預覽

```
python3 -m http.server 8000 --directory docs
```

然後開啟 http://localhost:8000

## 重新產生預設資料（選用）

如果想更新 `docs/data/market-data.json` 裡預設股票的最新資料：

```
pip install -r requirements.txt
python scripts/fetch_market_data.py
```

編輯 `scripts/watchlist.json` 可調整預設股票清單。這一步是選用的——即使不執行，
使用者仍然可以在網頁上直接輸入任何股票代號即時查詢。

## GitHub Pages 部署

1. 將這個資料夾推到 GitHub repo。
2. 到 repo 的 `Settings` -> `Pages`。
3. Source 選 `Deploy from a branch`。
4. Branch 選 `main`，資料夾選 `/docs`。

## 後端部署（Cloudflare Worker）

`worker/worker.js` 是一個單檔案的 Cloudflare Worker，免費方案即可執行，不需要額外綁定
KV 或資料庫。部署步驟：

1. 登入 Cloudflare Dashboard，建立一個新的 Worker。
2. 把 `worker/worker.js` 的內容整份貼進 Worker 編輯器並部署，會拿到一個
   `https://<worker 名稱>.<你的 subdomain>.workers.dev` 的網址。
3. 打開 `docs/app.js`，把最上面的 `const WORKER_BASE_URL = "";` 改成剛剛拿到的網址
   （不要加結尾斜線），再重新部署 GitHub Pages。
4. 如果前端網域不是 `https://<你的帳號>.github.io`，記得同步修改
   `worker/worker.js` 裡的 `ALLOWED_ORIGINS`，否則瀏覽器會擋掉跨網域請求。

這個 Worker 提供兩個端點：`/chart?symbol=&range=&interval=`（直接轉送 Yahoo 的 K
線資料，取代公開 CORS proxy）與 `/fundamentals?symbol=`（處理 Yahoo 的 cookie +
crumb 驗證流程後回傳本益比、EPS、市值等基本面欄位）。Yahoo 這條驗證流程是非官方、
沒有公開文件的內部端點，未來有可能失效或改版；Worker 內建失敗時自動重新取得
crumb 重試一次的邏輯，但無法保證長期穩定，前端也已對這個情況做了降級處理。
