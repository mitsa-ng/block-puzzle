# Block Puzzle — 方塊消除挑戰

## 檔案說明

| 檔案 | 說明 |
|------|------|
| `index.html` | 遊戲主體（唯一必要檔案，可獨立執行） |
| `multiplayer.js` | 多人房間、連線、障礙攻擊與對戰回放 client |
| `manifest.json` | PWA Web App Manifest（讓使用者可「加到主畫面」） |
| `sw.js` | Service Worker（離線快取支援） |
| `worker/index.mjs` | Cloudflare Worker／Durable Object room server |
| `wrangler.jsonc` | Durable Object binding 與 SQLite migration |

---

## 快速執行（本機測試）

直接用瀏覽器開啟 `index.html` 即可遊玩。

如果你想用本機伺服器測試（推薦，可避免某些瀏覽器的檔案存取限制）：

```bash
# Python 3
python -m http.server 8000
# 然後開啟 http://localhost:8000
```

> ⚠️ PWA 功能（加到主畫面、離線）需要透過 HTTPS 伺服器提供。

### 多人對戰本機測試

另開一個 terminal 啟動 Durable Object server：

```bash
npx -y wrangler@latest dev --local --port 8787 --config wrangler.jsonc
```

再啟動靜態前端：

```bash
python3 -m http.server 8000
```

用兩個獨立 browser session 開啟：

```text
http://localhost:8000/?mpServer=http://127.0.0.1:8787
```

其中一方建立「比分快賽」或「障礙對戰」，另一方輸入房碼加入，雙方按 Ready 即開始。多人 server 解析以明確的 `?mpServer=` 為最高優先；`mitsabkpuz.vercel.app` 未指定 query 時預設使用下方 Cloudflare Worker；任何 localhost／127.0.0.1／`[::1]` 則使用同 hostname 的 `8787`；其他正式自架網域仍連同源 `/room/{房碼}`，可自行反向代理 Worker。

兩種對戰都維持 180 秒：時間內先無法落子的一方立即判負（包含收到障礙後塞滿）；若雙方都撐到時間結束，則由總分較高者獲勝。

多人 lobby 會顯示雙方 Ready 狀態、房碼複製與即時比分差。完成對戰可解鎖 7 個本機成就；場次、勝場、連勝與成就保存在瀏覽器 `localStorage`（key：`bpz_duel_progress_v1`），不會上傳到 server。

多人歷史使用 `bpz_duel_replays_v1` 的 v2 分層格式：最多保留 50 場 allowlist 結果摘要，最近最多 8 場另存通過完整性驗證的 canonical 回放，總量限制為 3 MiB。超過回放數量或容量時會先把最舊完整回放降級為僅結果，所有回放都已降級仍超量才刪除最舊結果。可從多人區域的「歷史」查看、重新播放或刪除；資料只存在目前裝置，不包含房碼、token 或未知欄位，也不會混入單人歷史。

自動檢查：

```bash
node --test tests/multiplayer-worker.test.mjs
# Wrangler dev 執行中時，跑真實 WebSocket 雙 client smoke
node tests/multiplayer-live-smoke.mjs
node tests/score-knockout-live-smoke.mjs
MP_MODE=attack node tests/score-knockout-live-smoke.mjs
```

部署 room server：

```bash
npx -y wrangler@latest deploy --config wrangler.jsonc
```

正式 Vercel 網址 `https://mitsabkpuz.vercel.app` 預設會連到已部署的 `https://block-puzzle-multiplayer.xingencai060.workers.dev`。若要切換其他 room server，仍可在網址加 `?mpServer=https://你的-worker.example.workers.dev`，此 query override 優先於預設值。不要把 Cloudflare API token 或其他秘密寫進前端。

---

## 打包方式

### ① 靜態網頁（最簡單）

將整個資料夾上傳至任何靜態主機即可：

- **GitHub Pages**：建立 repo → 上傳檔案 → 開啟 Pages
- **Netlify**：拖曳資料夾到 [app.netlify.com/drop](https://app.netlify.com/drop)
- **Vercel**：`vercel --prod`
- **Cloudflare Pages**：連結 repo 或直接上傳

### ② Android APK（TWA — Trusted Web Activity）

1. 將靜態檔案部署到 HTTPS 網址
2. 使用 [Bubblewrap CLI](https://github.com/GoogleChromeLabs/bubblewrap)：
   ```bash
   npm i -g @bubblewrap/cli
   bubblewrap init --manifest https://你的網址/manifest.json
   bubblewrap build
   ```
3. 輸出 `.apk` 即可上架 Google Play 或直接安裝

### ③ Android / iOS（Capacitor）

```bash
npm install -g @capacitor/cli
npx cap init "Block Puzzle" "com.yourname.blockpuzzle"
# 複製 index.html 到 www/ 資料夾
cp index.html www/
npx cap add android   # 或 ios
npx cap open android  # 用 Android Studio 建置 APK
```

### ④ 桌面應用（Electron）

建立 `main.js`：
```js
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 480, height: 900 });
  win.loadFile('index.html');
});
```

建立 `package.json` 加入：
```json
{
  "main": "main.js",
  "scripts": { "start": "electron ." },
  "devDependencies": { "electron": "^latest" }
}
```

執行：
```bash
npm install
npm start
# 打包用 electron-builder 或 electron-forge
```

---

## PWA 加到主畫面（行動裝置）

1. 以 Chrome / Safari 開啟 HTTPS 網址
2. 點選「加入主畫面」或「安裝應用程式」
3. 即可像原生 App 一樣全螢幕執行，支援離線遊玩

---

## 遊戲說明

- 拖曳（桌面）或觸碰拖動（手機）下方方塊到網格
- 橫排或直列填滿時自動消除
- 同時消除越多條，Combo 獎勵越高
- 最高分自動儲存於瀏覽器 `localStorage`
- 遊戲進度於重整頁面後自動恢復
