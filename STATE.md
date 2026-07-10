# Loop State — My Project

Last run: 2026-07-10 — Vercel production 多人 client 資產修正、部署與手機驗證完成

## High Priority (loop is acting or waiting on human)

- 無阻斷項目；production 已更新並驗證。依安全規則等待 human 決定是否把 branch merge 回 `main`。

## Watch List

- 保持現有單人 new/resume/history/replay 流程。
- Multiplayer MVP 是 casual trust；公開排名／獎勵前需要 server-side rules validation。
- 修改已推送至 `codex/multiplayer-implementation` branch；工作目錄位於 `/private/tmp/block-puzzle-multiplayer`。

## Recent Noise (ignored this run)

---
Run log:

- 2026-07-10 baseline：原始頁在 `http://127.0.0.1:8765/` 正常顯示棋盤與三個方塊；inline scripts parse、`node --check sw.js`、`git diff --check` 通過。
- 2026-07-10 implementation：新增私人房、Ready/countdown、score HUD、15 秒重連、障礙攻擊、雙棋盤回放、rematch、Worker/Durable Object、receipts/settling/TTL 與 README。
- Automated：syntax/inline parse/diff check 通過；Node tests 20/20；Wrangler dry-run bundle 通過。
- Live：Wrangler local + 兩個 Node WebSocket clients 完成 create/join/Ready/start/forfeit/result/rematch；in-app Browser 單頁 UI smoke 與視覺檢查通過。
- Security live：匿名 socket 上限與持久化 join deadline 生效；UTF-8 超限訊息 fail closed；回放僅接受 inline bundle，不會向外部 URL 傳 token。
- Fresh-context verifier：上述三項安全 finding、syntax、20/20 tests、live multiplayer smoke 與 diff check 全數 PASS；未發現新 blocker。
- UI 分區：新增「單人遊戲／多人對戰」頂層入口；房碼與 Ready 只在多人頁顯示，多人大廳鎖定底下棋盤，結果關閉後仍保持鎖定。
- UI 驗證：Browser 雙向切換、障礙模式選取、hidden panel/HUD、console error 檢查通過；fresh-context verifier 修正 1 個 P2 後 PASS。
- 比分快賽規則：保留 180 秒；時間內先無法落子者立即判負，雙方撐到時間結束仍依總分；障礙模式不套用。
- 淘汰規則驗證：Worker tests 22/22、一般與 score knockout live WebSocket smoke、replay integrity 與 fresh-context verifier 全數 PASS。
- 障礙對戰規則：自行無法落子或障礙套用後無法落子都立即判負；雙方存活至 180 秒則維持比分結算。
- 障礙／回放驗證：score 與 attack 真實 knockout smoke 均確認雙方收到 `no_moves` 與 `replay_ready.available=true`；fresh-context verifier PASS。
- 多人 UX：新增房碼複製、雙方 Ready roster、比分差回饋、結果原因與新成就 chips、7 項本機成就／戰績 modal。
- UX 驗證：Browser desktop/390px、modal／copy／roster、console、storage-deny、重複 match_result/replay、22/22 tests 與 fresh-context verifier 全數 PASS。
- 加入房間重連：lobby reload 可用原 token 綁定新 page instance；stale token 只會清除並無 token 重試一次，避免無限 WebSocket 101 loop。
- 對戰中衝突：跨 page takeover 仍立即判負，原雙方各收到一次 `match_result` 與 `replay_ready`；衝突端只收到一次 `page_instance_mismatch`。
- 重連驗證：真實 Browser reload／第二 client join、三個 live WebSocket clients、Worker tests 24/24、JS syntax、diff check 與 fresh-context verifier 全數 PASS。
- WebSocket endpoint 快取修正：`multiplayer.js?v=14` 讓舊 Service Worker 首次載入也會避開舊 cache；v14 Service Worker 對同源 script 採 network-first，離線才回退 cache（含 ignoreSearch fallback）。
- Endpoint 驗證：舊 SW、刻意 stale v14 cache、完全離線 fallback、真實 `ws://127.0.0.1:8787/room/...` 101 handshake、inline parse、24/24 tests、diff check 與 fresh-context verifier 全數 PASS；未觀察到 8765 WebSocket。
- 本機預設 endpoint：未帶 `mpServer` 的 `localhost/127.0.0.1/[::1]:8765` 會自動改用同 hostname `8787`；明確 query 優先，其他 origin 不變。
- Chrome 驗證：無 query 與明確 query 均只建立 8787 WebSocket 且 handshake 101；持續 16 秒無重連、8765 `/room` request 為 0；v15 離線載入與 client self-test、24/24 Worker tests、fresh-context verifier 全數 PASS。
- 多人歷史回放：`bpz_duel_replays_v1` 升為 v2 分層格式，matchId 去重、最多 50 筆結果／最近 8 筆完整 replay／3 MiB；超限先降級舊 replay 為 result-only，最後才刪最舊結果。
- 歷史安全：保存前綁定 envelope／bundle／result／current matchId 與本機參賽身份，深層 canonical allowlist 不落盤 token／room／未知欄位；generation gate 阻止 rematch async replay race。
- 歷史 UX：多人戰績新增「歷史」入口，成就／歷史 ARIA tabs、勝負／模式／比分／原因 cards、單筆刪除／清除、雙棋盤播放與返回；v17 app shell。
- 歷史驗證：真實完成一局→保存→播放→返回→reload 持久化、390px 無水平溢出、keyboard tabs／focus、console、client self-test、inline parse、Worker tests 24/24、diff check；兩輪 verifier findings 修正後 final PASS。
- 分層驗證：v1→v2 migration、10 筆 8 full／2 result-only、50 cap、UTF-8／Quota downgrade-first、duplicate restore full、深層損壞自動降級、reload、result-only disabled UI、v19、24/24 tests 與 fresh-context verifier final PASS。
- Vercel 根因：`.vercelignore` 是 allowlist 但未包含 `!multiplayer.js`，production HTML 因此載入 404，導致多人 tab 沒有 click handler 且 Service Worker install 失敗。
- Vercel 修正：allowlist 加入 `!multiplayer.js`；CLI dry-run 與 preview deployment 均包含 8 個檔案及 `multiplayer.js`，syntax、inline parse、Worker tests 24/24、diff check 與 fresh-context verifier 全數 PASS。
- Production 部署：deployment `dpl_249PGzWvq1xWn7d9KmxfXkTc4r3V` 已 alias 至 `https://mitsabkpuz.vercel.app`；首頁、`multiplayer.js`、`sw.js` 均回 200。
- Production 手機驗證：Browser 390×844 可由單人切換到多人 tab，tabpanel 正常顯示、無水平溢出且 console logs 為空。
