# Production Multiplayer Load Test — 2026-07-10

## 目標

驗證 `wss://block-puzzle-multiplayer.xingencai060.workers.dev` 在真實 1v1 房間生命週期下，能承受漸進式高併發連線而不破壞建立、加入、Ready、開始與結算流程。

## 驗收條件

- 階段：25／100／250 個同時房間，等同 50／200／500 個 WebSocket clients。
- 每房完整執行 create、join、雙方 Ready、match start、forfeit/result，再正常關閉 socket。
- 每階段錯誤率不超過 1%；若超過 1% 或觀察到持續 5xx／握手失敗即停止後續加壓。
- 記錄 connect／join／start／result latency 的 p50、p95、max，以及成功率與失敗原因。
- 由獨立 verifier 檢查測試程式、原始結果與結論。

## 結果

### 漸進階段

| 房間／設計 clients | Gameplay 成功 | Connect p95 | Join p95 | Start p95 | Result p95 | 耗時 |
|---:|---:|---:|---:|---:|---:|---:|
| 2／4 | 2/2 | 1170 ms | 84 ms | 96 ms | 75 ms | 9.18 s |
| 25／50 | 25/25 | 1166 ms | 82 ms | 141 ms | 85 ms | 9.39 s |
| 100／200 | 100/100 | 1304 ms | 82 ms | 132 ms | 81 ms | 10.73 s |
| 250／500 | 248/250 | 1370 ms | 86 ms | 107 ms | 87 ms | 29.34 s |

首輪 250-room 階段有 2 房的 host 等待 `match_result` 超過 20 秒（0.8%），沒有 WebSocket handshake failure 或 HTTP 5xx。壓測後 2-room 健康檢查為 2/2 gameplay PASS。

### 嚴格 peak 重跑

修正 harness 後加入實際 open-socket peak、雙端 transcript、fatal／close event、身份與 room 驗證，以及 graceful close 成功條件。單獨重跑 250 rooms 得到：

- 實際同時開啟峰值：500 sockets。
- Gameplay lifecycle：250/250 房、500/500 clients 均完成 create／join／雙 Ready／match start／5 秒 hold／forfeit／雙方 `match_result`。
- Handshake failure／HTTP 5xx：0。
- p50／p95／max：connect 862／1349／1860 ms；join 66／110／150 ms；start 75／111／271 ms；result 67／84／221 ms。
- 階段耗時：12.83 秒。
- Graceful close：0/500 sockets；全部在 client `close(1000)` 後 5 秒未收到正常 close event，強制 terminate 後為 code 1006。

### 結論

- Gameplay 高負載：PASS；實測 500 個同時 WebSocket clients 時 250/250 房完成至雙方結果。
- 連線關閉：FAIL；正常 close handshake 目前 500/500 失敗，需另案調查 Cloudflare／Worker close 流程後修正。
- 原始證據：`/tmp/block-puzzle-prod-load/results.json`、`v2-sanity.json`、`v2-peak.json`、`post-health.json`；獨立 verifier 已重算 raw metrics 並確認上述結論。
