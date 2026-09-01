---
paths:
  - 'src/content/media-attempt-log.ts'
  - 'src/content/downloader.ts'
---

# ZIP フェーズのメディア取得 (Issue #51)

**429 の制御が無く、観測だけを持つ。** `fetchWithRetry` は失敗のたびに 1 秒待って再試行するだけで (1 対象につき最大 2 回)、429 と 404 / 500 を区別せず `Retry-After` も待機に使わない。収集フェーズのバックオフとも無関係で、取得先ホストも異なる。

メディアは ZIP の書き込み順を維持したまま既定 3、設定可能範囲 1〜4 で先行取得する。
ZIP writer と保存先を準備する前に通信を始めないため、共有層が最初の `fetchFile` を呼んだ時点でプールを起動する。
並列数は進行中の HTTP 取得数の上限であり、メディア取得間隔の設定ではない。
取得した Blob は共有層が要求する順番で返すため、通信の完了順が前後しても ZIP 内の順序と進捗ログの意味は変えない。
中断時は開始前の job を `null` として解決し、開始済みの取得は Port 切断で service worker 側の fetch まで abort する。

制御方式を決める前に観測が要るため、試行記録を `chrome.storage.local` の `fbdlMediaAttempts` に蓄積する (`src/content/media-attempt-log.ts`)。URL も投稿名も含めず、どこにも送信しない。上限 2000 件。

保存は `downloadAsZip` の `finally` で行う。**観測したい 429 は失敗した実行にこそ現れる**ので、成功時だけ保存すると最も見たい事象が落ちる。

読み出し・集計・削除の手順は `.agents/skills/extension-live-test/SKILL.md` が SoT。
