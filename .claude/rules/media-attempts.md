---
paths:
  - 'src/content/media-attempt-log.ts'
  - 'src/content/downloader.ts'
---

# ZIP フェーズのメディア取得 (Issue #51)

**429 は同一 ZIP 実行・同一 host の cooldown で制御する。** `fetchWithRetry` は `Retry-After` を共有期限へ反映し、各対象の初回取得と再試行の直前に期限を待つ。
読めない `Retry-After` は 1 秒へ倒し、429 以外の失敗は対象単位で 1 秒待つ。
並列 worker が429を観測した時点ですでに発行済みの要求は止めないが、その後の新規発行と全再試行は共有期限まで止める。
収集フェーズのバックオフとはスコープを分ける。取得先ホストが異なり、ZIP 中断時に捨てるべき状態だからである。

メディアは ZIP の書き込み順を維持したまま既定 3、設定可能範囲 1〜4 で先行取得する。
ZIP writer と保存先を準備する前に通信を始めないため、共有層が最初の `fetchFile` を呼んだ時点でプールを起動する。
並列数は進行中の HTTP 取得数の上限であり、メディア取得間隔の設定ではない。
取得した Blob は共有層が要求する順番で返すため、通信の完了順が前後しても ZIP 内の順序と進捗ログの意味は変えない。
中断時は開始前の job を `null` として解決し、開始済みの取得は Port 切断で service worker 側の fetch まで abort する。

429 制御の動作と実サイトの応答を後から検証できるよう、試行記録を `chrome.storage.local` の `fbdlMediaAttempts` に蓄積する (`src/content/media-attempt-log.ts`)。URL も投稿名も含めず、どこにも送信しない。上限 2000 件。

保存は `downloadAsZip` の `finally` で行う。**観測したい 429 は失敗した実行にこそ現れる**ので、成功時だけ保存すると最も見たい事象が落ちる。

読み出し・集計・削除の手順は `.agents/skills/extension-live-test/SKILL.md` が SoT。
