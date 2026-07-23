# 美股成交量與 KD 監控 Dashboard

這是一個可部署到 GitHub Pages 的靜態儀表板，用來追蹤美股成交量、KD 指標，以及簡單示警條件。複製自 589411.github.io/stock-dashboard ，並把新增觀察功能改成真的能即時抓取任意美股代號。

## 功能

顯示最近 5 個交易日的收盤價、成交量、K、D、K與D的變化。視覺化近 30 筆日線資料，包含收盤價、成交量、K 線與 D 線。示警條件包含：成交量相對近 5 日均量變化超過 15%，K 或 D 高於 80，K 或 D 低於 20。支援多股票觀察清單，預設含 MU、GOOGL、NVDA、AMD、TSM、AAPL。輸入任意美股代號並按加入，前端會即時向 Yahoo Finance 抓取日線資料，在瀏覽器內計算 KD 與量能指標，馬上顯示在儀表板上。即時加入的股票代號會存在瀏覽器的 localStorage，重新整理頁面後仍會保留。

## 本機預覽

用終端機執行 python3 -m http.server 8000 --directory docs 然後開啟 localhost:8000。

## GitHub Pages 部署

到 repo 的 Settings 頁面，找到 Pages 設定，Source 選擇 Deploy from a branch，Branch 選 main，資料夾選 /docs。
