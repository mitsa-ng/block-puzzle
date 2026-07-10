# 多人對戰 L2 實作筆記

## 目標

在獨立 git worktree 實作私人房 1v1、180 秒同序列比分、障礙對戰、對戰回放與 Cloudflare Durable Object room server，同時保留既有單人流程。

### 2026-07-10 UI 分區調整

- 目標：把單人遊戲與多人對戰拆成兩個明確入口，不再把房碼／Ready 控制混入單人畫面。
- 驗收：預設只顯示單人遊戲；切換「多人對戰」後才顯示模式、暱稱、房碼與 Ready；切回單人時恢復原本單人流程。
- 驗證：JS parse、既有 Worker tests、Browser 雙向切換、console error 檢查與 fresh-context verifier。

### 2026-07-10 比分快賽淘汰規則

- 目標：保留 180 秒計時；時間內先無法落子的一方立即判負。
- 驗收：即使先無法落子者當下分數較高，對手仍立即獲勝；若雙方撐到 180 秒則維持總分決勝；障礙模式不套用此規則。
- 驗證：Worker reducer tests、真實 Wrangler WebSocket smoke 與 fresh-context verifier。

### 2026-07-10 障礙對戰淘汰規則

- 目標：障礙對戰也採「先無法落子者立即判負」，包含自己的棋盤塞滿與障礙套用後塞滿。
- 驗收：兩種 game-over 回報都立即產生 `no_moves`；180 秒計時與時間到比分決勝仍保留；結果同步附可播放 replay。
- 驗證：Worker reducer tests、score/attack 真實 WebSocket knockout smoke、replay-ready assertion 與 fresh-context verifier。

### 2026-07-10 多人 UX 與成就

- 目標：強化多人 lobby／Ready／對手狀態的即時回饋，加入 client-only 成就、進度與解鎖提示，不修改 server protocol。
- 驗收：多人 panel 顯示雙方席位與 Ready 狀態；成就可開關查看、localStorage 持久化、結果後更新勝場／連勝／模式條件；鍵盤、mobile 與 reduced-motion 可用。
- 不變式：單人流程、房間重連、180 秒與 no-moves 結算、replay、Worker contract 不變。
- 驗證：JS parse、Worker tests、client self-test、Browser lobby／成就互動、mobile visual、console、fresh-context verifier。

### 2026-07-10 加入房間重連修正

- 目標：修正 lobby reload 的 `page_instance_mismatch`，以及 slot 過期後 stale token 造成的無限 WebSocket 重連。
- 驗收：lobby token 可安全綁定新的 page instance；對戰中仍禁止跨 page takeover，且原雙方會收到判負與 replay；invalid token 只清除一次並以無 token 重新加入，不形成 101 reconnect loop。
- 驗證：Worker tests 24/24、真實 Browser reload／第二 client join、三個 live WebSocket clients、Worker log、JS syntax／diff check、fresh-context verifier PASS。

### 2026-07-10 WebSocket endpoint 快取修正

- 目標：避免舊 Service Worker 快取的 multiplayer client 忽略 `mpServer`，錯連靜態頁面的 `8765`。
- 驗收：HTML 以版本化 script URL 跨過舊 cache；新版 Service Worker 對同源 script 採 network-first，離線仍可由未版本化預快取 fallback。
- 驗證：舊 SW 首載、stale v14 cache、完全離線、真實 8787 WebSocket 101 handshake、Browser console、inline parse、Worker tests 24/24、fresh-context verifier PASS。

### 2026-07-10 本機 multiplayer server 預設值

- 目標：直接開啟任何 localhost／127.0.0.1／`[::1]` 前端時，不必手動加入 `mpServer` query 也能連到同 hostname 的 Worker `8787`。
- 驗收：明確 `mpServer` query 永遠優先；所有 loopback hostname 預設改用 `8787`；`mitsabkpuz.vercel.app` 預設使用 `block-puzzle-multiplayer.xingencai060.workers.dev`；其他部署仍使用目前 origin，保留自架反向代理能力。
- 驗證：client self-test 覆蓋 query、三種 loopback、Vercel 特例與其他 origin；Chrome 無 query 建房、8787 WebSocket 101、8765 無 `/room`、Worker tests 與 fresh-context verifier。

### 2026-07-10 多人歷史回放

- 目標：把已完成的多人 replay 保存為獨立歷史，讓玩家稍後仍可依模式、勝負與時間重新播放，不混入單人歷史。
- 驗收：只保存通過既有完整性檢查且屬於目前玩家的 replay；本機持久化有版本、數量／容量上限、重複 match 去重與損壞資料降級；多人區域提供可鍵盤／觸控操作的歷史列表、空狀態、刪除與播放入口；既有即時回放與單人流程不變。
- 驗證：v17 client self-test、storage-deny／corrupt／duplicate／quota 與 async rematch race guard、desktop／390px Browser、實際完成一局後保存→播放→返回→reload、keyboard／console、Worker tests 24/24；兩輪 verifier findings 修正後 final PASS。

### 2026-07-10 多人歷史分層保留

- 目標：避免多人紀錄增加時持續保存完整落子流程；近期紀錄可回放，較舊紀錄仍保留對戰結果摘要。
- 驗收：最多 50 筆結果；僅最近 8 筆可保留 replay bundle。超過 8 筆或 3 MiB 時先把最舊完整 replay 降級成 result-only，再到 50 筆才刪最舊結果。既有 v1 資料可無損 migration；result-only 卡片清楚顯示「僅保留結果」且不可播放，刪除功能照常。
- 驗證：v1→v2 migration、duplicate restore full、10 筆 8/2 分層、50 cap、UTF-8／Quota downgrade-first、深層損壞自動降級與 reload、result-only disabled UI、Browser v19／console、client self-test、Worker tests 24/24；verifier finding 修正後 final PASS。

### 2026-07-10 Vercel 多人 client 資產

- 目標：確保 Vercel production 同時部署 `index.html` 與負責多人頁籤事件的 `multiplayer.js`。
- 驗收：`.vercelignore` allowlist 包含 `multiplayer.js`；production `/multiplayer.js` 回 200；mobile viewport 可切到多人頁；Service Worker app-shell install 不再因缺少資產而失敗。
- 驗證：Vercel deployment file list／HTTP 200、production mobile Browser 點擊、console／network、Worker tests 與 fresh-context verifier。

### 2026-07-10 Production 多人 Worker endpoint

- 目標：讓 `https://mitsabkpuz.vercel.app` 預設連線至已部署的 Cloudflare Durable Object Worker，同時保留 `mpServer` query override、本機 8787 規則與其他自架網域的同源行為。
- 驗收：production 不帶 query 即可建立／加入房間；兩位真實 clients 可 Ready、完成倒數並進入對戰；舊 Service Worker cache 不會繼續使用錯誤 endpoint。
- 驗證：公開 Worker WebSocket smoke、production 雙 Browser client、console／network、Worker 24/24、client self-test、syntax／inline parse、diff check 與 fresh-context verifier。

## 採用 defaults

- 斷線立即暫停；15 秒內同頁重連，否則判負。
- `commandId` 使用 `crypto.randomUUID()`；重送沿用，payload 衝突 fail closed。
- 回放錯誤一律不播放部分資料，顯示明確錯誤／重試。
- 障礙模式採已驗證的 settling、canonical RNG、atomic freeze 與 `finalBoardEventSeq` 契約。

## 驗收條件

- 單人 new/resume、落子、消行、game over、history/replay 保持可用。
- 可建立／加入兩人房、Ready、同步開始、比分與結算。
- 障礙模式每清一條 row／column 向對手送 1 格，棋盤上限 10；重送不重複套用。
- 結果頁能重播雙方 move/attack events；完整性錯誤 fail closed。
- Worker room state、command receipt、disconnect grace、settling/result 與 replay retention 有最小自動檢查。
- README 記錄本機與部署方式；`STATE.md` 記錄實跑證據。

## 進度

- [x] 建立 L2 worktree 與工作筆記
- [x] 記錄 baseline：原始頁 DOM 正常、inline scripts parse、`sw.js` parse、`git diff --check` 均通過
- [x] 實作 client／遊戲 hook
- [x] 實作 Durable Object room
- [x] 實作障礙與回放
- [x] 自動檢查與 browser／live WebSocket smoke
- [x] fresh-context verifier

## 驗證證據

- `node --check multiplayer.js worker/index.mjs sw.js`：通過。
- `index.html` 兩段 inline script 以 `new Function` parse：通過。
- `node --test tests/*.test.mjs`：20/20 通過。
- Wrangler 4.110.0 dry-run bundle：通過，`GAME_ROOMS (GameRoom)` binding 正常。
- 真實 Wrangler server + 兩個 Node WebSocket client：create/join/Ready/start/forfeit/result/rematch 通過。
- 真實 Wrangler security smoke：匿名 socket 約 25 秒以 `1008/join_timeout` 關閉，第 5 個待登入連線遭拒；120,164 UTF-8 bytes 訊息回 `message_too_large`。
- In-app Browser：多人 UI、模式、房碼、狀態、HUD、棋盤與 touch targets 顯示正常；backend 只提供單 tab，因此雙 client 改由 live WebSocket smoke 覆蓋。
- UI 分區 Browser smoke：預設只顯示單人內容；多人 tab 才顯示私人房控制，模式切換與返回單人正常，lobby 棋盤保持鎖定，console 無 error／warning。
- `git diff --check`：通過。
- Fresh-context verifier：三項安全 finding 與 regression suite 全部 PASS，未發現新 blocker。
- UI 分區 fresh-context verifier：結果關閉路徑的棋盤鎖定修正後 PASS，未發現新 blocker。
- 比分快賽淘汰規則：180,000ms 計時維持不變；`no_moves` 立即結算、障礙模式不立即結算，Worker tests 22/22 通過。
- `node tests/score-knockout-live-smoke.mjs`：真實 Wrangler 雙 client 在倒數開始後立即產生 `no_moves` 勝負，通過。
- `no_moves` replay：client/server 均驗證 participant、winner、scores 與 reason；ghost ID／未知 reason fail closed。
- 淘汰規則 fresh-context verifier：兩輪審查後 PASS，未發現新 blocker。
- 障礙對戰淘汰：`game_over` 與 `attack_applied gameOver=true` 均立即結算，pending／committed attack 原子清理，Worker tests 22/22 通過。
- `MP_MODE=attack node tests/score-knockout-live-smoke.mjs`：雙方收到 `reason=no_moves` 與可用 replay bundle，通過。
- 障礙淘汰 fresh-context verifier：180 秒邊界、score/attack live、late mutation 與 replay integrity 全部 PASS。
- 多人 UX：房碼複製、雙方 Ready roster、即時比分差、結果原因、新成就 chips 與 7 項本機成就／戰績 modal 完成。
- Browser：desktop 與 390px layout、成就開關、房間建立、roster、copy success、44px controls、reduced-motion 與 console 檢查通過。
- 成就安全性：`bpz_duel_progress_v1` storage deny 可降級、matchId 重送不重複累計，且不會覆寫既有 replay 狀態。
- 多人 UX fresh-context verifier：修正 storage deny 與 duplicate-result replay 兩項 finding 後 PASS，未發現新 blocker。
