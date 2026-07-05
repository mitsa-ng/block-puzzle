# Block Puzzle — 方塊消除挑戰

## 檔案說明

| 檔案 | 說明 |
|------|------|
| `index.html` | 遊戲主體（唯一必要檔案，可獨立執行） |
| `manifest.json` | PWA Web App Manifest（讓使用者可「加到主畫面」） |
| `sw.js` | Service Worker（離線快取支援） |

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
