---
paths:
  - 'src/content/fanbox/api.ts'
  - 'src/service-worker/handlers.ts'
  - 'src/service-worker/backoff-store.ts'
---

# API のレート制御 (ValerianDillon/fanbox-downloader#3)

ゲート・再試行・適応スロットル・直列化・エラー型は共有層の `ApiSession` が持つ。拡張側 (`src/content/fanbox/api.ts`) は `Transport` の実装と、FANBOX 固有の URL 組み立て・レスポンス検証だけを持つ。ブックマークレット版と同じ契約・同じテストを通すため。

- transport は 3 系統を返す。`response` (status を観測できた) / `unobservable-failure` (応答を得られなかった) / `deferred` (I/O を発行しなかった)。**observable な 429 と「429 かもしれない失敗」を型で分け、後者から status を推測しない**
- service worker が既知のバックオフ期限中で fetch を発行しなかった応答は `deferred` へ変換する。adapter の内側で待って再要求すると、セッションが実際の発行時刻を見失って基準間隔と適応間隔が抜けるため、**待機と再発行はセッションが行う**
- 再試行ポリシーはセッション側にある。詳細は共有層の JSDoc が SoT

## 状態のスコープ

2 つに分かれる。

- **収集ごと** — 基準間隔・適応間隔・再試行回数・連続成功数 (`ApiSession` を収集ごとに作る)
- **service worker (`chrome.storage.session`)** — サーバー指定のバックオフ期限。タブと収集をまたぐ (Issue #16)

`api.ts` の `sharedBackoffUntil` は後者の参照値で、更新は `fetchApi` の応答からのみ行う。**発行の前に問い合わせて取り込むことはしない** — 往復のぶん実際の発行が遅れ、往復の所要時間が要求ごとに違うと実発行間隔が基準間隔を下回る。期限の最終判定は service worker 側のゲートが持ち、そこで弾かれた応答が最新の期限を運んでくる。

`Retry-After` の解釈は共有層の `parseRetryAfterMs` に一本化する。期限を記録する service worker と待機時間を決めるセッションで解釈が違うと、セッションが「読めないので固定バックオフ」と判断した値を service worker が期限として記録し、タブと収集をまたいで長すぎる待機になる。

## 発行時刻の扱い (Issue #46)

service worker が実際に `fetch` を開始した時刻を応答に載せ、セッションがそれを記録する。セッションが自前で記録するのは `sendMessage` の直前なので、service worker の起動待ちで配送が遅れると記録と実発行がずれ、次のゲートがその遅延ぶん早く明ける。

報告値は別プロセス由来なので、実際の発行が起きうる区間 (`transport` 呼び出しの直前〜応答が返った時刻) に収まっていればそのまま採る。

外れた値は**区間の上端に倒す**。区間内のどこで発行されたか分からない以上、真の発行時刻以降と確実に言えるのは上端だけで、下端に倒すと配送が遅れていた場合に次の発行が早まる。報告そのものが無いとき (旧 service worker、同一プロセスで発行するブックマークレット版) だけ下端を使う。

送信後にキャンセルすると応答が transport に届かないため、実発行時刻は記録されない。キャンセル直後の再収集が進行中の `fetch` と間隔を空けない件は Issue #49。
