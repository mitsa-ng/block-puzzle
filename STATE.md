# Loop State — My Project

Last run: 2026-07-10 — L2 本地回放收藏已獲 human 核准 commit／push

## High Priority (loop is acting or waiting on human)

- 目標：讓使用者從最近回放選擇要永久保存的項目，存入 localStorage，並可用檔案 export/import 轉移。
- 格式：versioned plain JSON，副檔名 `.bpz-replays.json`；保留可攜性、可檢查性與未來 migration 空間。
- 驗收條件：重新整理後收藏仍存在；收藏可播放／刪除；export/import round-trip 資料一致；壞檔與未知版本 fail closed；quota 失敗明確提示；手機操作入口至少 44px。
- 實作已完成：最近／已收藏清單、播放／刪除、JSON export/import、deterministic content ID、50 筆／4 MiB 上限與完整 replay validation。
- 自驗：JS syntax、`git diff --check`、HTTP 200；390×844 Chromium 完成收藏→refresh→播放、刪除、export→清空→import，invalid JSON／未知 version／ID conflict 皆不改原資料，quota failure 顯示繁中提示，新控制皆 44px 高。
- Attempt 2：依 verifier finding，runtime 與 validator 改共用純進度 helper；匯入會 deterministic 核對每步分數及最終 score／level／lines／maxStreak。
- Attempt 2 自驗：合法單步 history/export round-trip 通過；分別竄改 score、level、lines、maxStreak、move.s 均 fail closed，storage 與 memory 保持不變；Chromium console/page error 為空。
- 狀態：attempt 2 fresh-context verifier PASS；human 已核准 commit／push `codex/local-replay-export`，未授權 merge main。

## Watch List

- 不得假設多人回放 runtime 已存在；本次只接現有單機 history/replay engine。
- 匯入必須先驗完整包再原子合併，不得留下部分髒資料；ID 衝突內容不同時拒絕。

## Recent Noise (ignored this run)

---
Run log:

- 2026-07-10 發布：human 已核准推送目前回放分支；scope 僅 `index.html` 與 `STATE.md`，不建立 PR、不 merge main。
- 2026-07-10 L2：human 要求新增本地回放收藏與檔案轉移；已建立 `codex/local-replay-export` worktree，尚未 merge／push。
- 2026-07-10 實作自驗：README localhost 以 `python3 -m http.server 8766 --bind 127.0.0.1` 回 200；repo 無 automated tests。乾淨頁面無 page error／HTTP 4xx；未做 fresh-context 驗證。
- 2026-07-10 verifier attempt 1 FAIL：metadata 僅驗型別，偽造 score／level／lines／maxStreak 可通過。Attempt 2 已用共用 runtime 規則修正並完成自驗，等待新的 fresh-context verifier。
- 2026-07-10 verifier attempt 2 PASS：三次清行 score `29→68→112`、streak `1→2→3`、level 跨至 2；收藏／JSON round-trip／播放通過。逐項竄改 score／level／lines／maxStreak／move.s 均 fail closed，storage 與 memory 不變；syntax、diff、HTTP、console 全綠。
