# fanbox-downloader-extension

pixiv FANBOX 一括ダウンロード Chrome 拡張 (Manifest V3)。ブックマークレット版 fanbox-downloader を移行したもの。

FANBOX 固有の収集ロジックと ZIP 生成は `download-helper` に集約されている。拡張が担うのは、service worker 経由の fetch 差し替えや `FileSystemFileHandle` 取得など拡張固有の処理だけ。

## コマンド

- `bun run build` — content script + service worker をバンドルし、静的ファイルを `dist/` にコピー
- `bun run build:test` — テストビルド版 (`__FBDL_TEST__=true`) を `dist-test/` に出力
- `bun run lint` / `bun run typecheck`
- `bun run test` — `test/` 配下のユニットテスト。**素の `bun test` は使わない** (リポジトリ全体を探索して `e2e/*.spec.ts` も拾う)
- `bun run test:smoke` — `dist-test/` をビルドし、Playwright で smoke test を実行

## プロセス構成

**content script + service worker の 2 プロセス。** content script が UI (FAB / overlay) とデータ収集と ZIP 生成を担い、service worker を fetch プロキシとして使う。

content script の fetch はページ origin として扱われ、`downloads.fanbox.cc` などが CORS でブロックされる。host_permissions を持つ service worker 経由で取得する必要がある。

overlay は状態マシン (`settings` → `collecting` → `downloading` → `complete`)。UI は shadow DOM でページのスタイルから隔離する。

キャンセルは AbortController。メディア転送では content script が Port を切断し、service worker がそれを受けて進行中の fetch を abort する。`sendMessage` 経路は signal と競争させて待ちを打ち切る (送信済みリクエスト自体は取り消せない)。

## メディア取得の分割転送 (Issue #22)

単発の `sendMessage` の応答に本文全体を base64 で載せる方式は、runtime messaging の 64 MiB 上限に base64 の 4/3 膨張込みで当たり、**約 48 MiB 以上のファイルが必ず失敗していた**。

content script が Port を張り、service worker が本文を `CHUNK_BYTES` (8 MiB) ごとに chunk へ分けて流す。ワイヤ契約は `src/media-stream-protocol.ts` に集約し、両バンドルで共有する。

- **MV3 の service worker はいつでも停止しうる** (30 秒無活動 / 5 分上限 / fetch 応答 30 秒)。転送途中で Port が切れたら、受信済みバイト数を offset にした `Range` 要求で新しい Port を張って再開する。切断が続けば `MAX_RESUMES` 回で諦めて上位の再試行に委ねる
- 低速回線で `CHUNK_BYTES` が 30 秒以内に溜まらないと転送中に停止するため、chunk が満たなくても `FLUSH_INTERVAL_MS` ごとに送って idle timer をリセットする (Chrome 114 以降、Port はメッセージ送受信でもリセットされる)
- **本文全体を JS ヒープに保持しない。** 受信合計を `Content-Length` と終端メッセージのバイト数に突き合わせ、一致しなければ成功にしない (欠けたファイルを ZIP に入れないため)
- API 取得 (`fetchApi`) は単発の `sendMessage` のまま。JSON はサイズ上限に達しない

再開の分岐と、実サイトで Range 再開が効かない理由は `src/content/media-stream.ts` の JSDoc が SoT。

## API のレート制御 (ValerianDillon/fanbox-downloader#3)

ゲート・再試行・適応スロットル・直列化・エラー型は共有層の `ApiSession` が持つ。拡張側 (`src/content/fanbox/api.ts`) は `Transport` の実装と、FANBOX 固有の URL 組み立て・レスポンス検証だけを持つ。ブックマークレット版と同じ契約・同じテストを通すため。

- transport は 3 系統を返す。`response` (status を観測できた) / `unobservable-failure` (応答を得られなかった) / `deferred` (I/O を発行しなかった)。**observable な 429 と「429 かもしれない失敗」を型で分け、後者から status を推測しない**
- service worker が既知のバックオフ期限中で fetch を発行しなかった応答は `deferred` へ変換する。adapter の内側で待って再要求すると、セッションが実際の発行時刻を見失って基準間隔と適応間隔が抜けるため、**待機と再発行はセッションが行う**
- 再試行ポリシーはセッション側にある。詳細は共有層の JSDoc が SoT

### 状態のスコープ

2 つに分かれる。

- **収集ごと** — 基準間隔・適応間隔・再試行回数・連続成功数 (`ApiSession` を収集ごとに作る)
- **service worker (`chrome.storage.session`)** — サーバー指定のバックオフ期限。タブと収集をまたぐ (Issue #16)

`api.ts` の `sharedBackoffUntil` は後者の参照値で、更新は `fetchApi` の応答からのみ行う。**発行の前に問い合わせて取り込むことはしない** — 往復のぶん実際の発行が遅れ、往復の所要時間が要求ごとに違うと実発行間隔が基準間隔を下回る。期限の最終判定は service worker 側のゲートが持ち、そこで弾かれた応答が最新の期限を運んでくる。

`Retry-After` の解釈は共有層の `parseRetryAfterMs` に一本化する。期限を記録する service worker と待機時間を決めるセッションで解釈が違うと、セッションが「読めないので固定バックオフ」と判断した値を service worker が期限として記録し、タブと収集をまたいで長すぎる待機になる。

### 発行時刻の扱い (Issue #46)

service worker が実際に `fetch` を開始した時刻を応答に載せ、セッションがそれを記録する。セッションが自前で記録するのは `sendMessage` の直前なので、service worker の起動待ちで配送が遅れると記録と実発行がずれ、次のゲートがその遅延ぶん早く明ける。

報告値は別プロセス由来なので、実際の発行が起きうる区間 (`transport` 呼び出しの直前〜応答が返った時刻) に収まっていればそのまま採る。

外れた値は**区間の上端に倒す**。区間内のどこで発行されたか分からない以上、真の発行時刻以降と確実に言えるのは上端だけで、下端に倒すと配送が遅れていた場合に次の発行が早まる。報告そのものが無いとき (旧 service worker、同一プロセスで発行するブックマークレット版) だけ下端を使う。

送信後にキャンセルすると応答が transport に届かないため、実発行時刻は記録されない。キャンセル直後の再収集が進行中の `fetch` と間隔を空けない件は Issue #49。

## ZIP フェーズのメディア取得 (Issue #51)

**429 の制御が無く、観測だけを持つ。** `fetchWithRetry` は失敗のたびに 1 秒待って再試行するだけで (1 対象につき最大 2 回)、429 と 404 / 500 を区別せず `Retry-After` も待機に使わない。収集フェーズのバックオフとも無関係で、取得先ホストも異なる。

制御方式を決める前に観測が要るため、試行記録を `chrome.storage.local` の `fbdlMediaAttempts` に蓄積する (`src/content/media-attempt-log.ts`)。URL も投稿名も含めず、どこにも送信しない。上限 2000 件。

保存は `downloadAsZip` の `finally` で行う。**観測したい 429 は失敗した実行にこそ現れる**ので、成功時だけ保存すると最も見たい事象が落ちる。

読み出し・集計・削除の手順は `.claude/skills/extension-live-test/SKILL.md` が SoT。

## FANBOX API の落とし穴

- 配列レスポンスは `body` 直下ではなく `body.<キー>` に入る。形状が想定と違うときに空配列へ落とすと「本当に 0 件」と区別が付かず、中身のない ZIP を完了として出してしまうので `ApiShapeError` で中断する
- `post.listCreator` の一覧レスポンスには本文が含まれないため、各投稿は `post.info` への追加リクエストを経て収集される
  - 一覧の時点で結果が決まる投稿 (`isRestricted`、「無料を省く」指定に該当する `feeRequired === 0`) は `post.info` を発行せずに飛ばす。発行しても弾かれるだけで、レート制限の枠と待機時間を消費する
  - この判断に使う `id` / `isRestricted` / `feeRequired` は一覧要素の validator で検証する。欠けたまま続けると、利用者が指定した除外が無言で効かなくなる
- ZIP のルートに `download-manifest.json` が入る。`stringify()` は「全件を選択した projection」なので、その記録が書き出される。絞り込み UI はまだ無いので常に全件 (Issue #55 で選択できるようにする)

### 失敗の扱いはエラー型で決まる

投稿単位・ページ単位の失敗として数えて続行してよいのは `HttpError` (2xx 以外の応答) だけ。それ以外を握りつぶすと、実装上のバグまで通信障害として数えたまま収集が続く。

- **再試行枠の枯渇は収集全体を止める。** 上限まで待った直後に別のエンドポイントへ要求を出すのは、再試行上限を実質的に延長することになるため、プラン名・タグの取得中でも握りつぶさない。取り込めた投稿があれば `stoppedReason` を付けて部分保存し、1 件も無ければ例外として扱う
- **安全に取り込めない仕様変更は中断する。** 判定は `overlay.ts` の `isUnsupportedResponseError` が SoT
- 例外は `plan.listCreator` と `tag.getFeatured` の 2 つだけ。形状の不一致も HTTP エラーも握りつぶして続行する (表示の補助しか担っておらず、ZIP の中身は欠けないため)。枯渇だけは再送出する
- 取得できなかった投稿は失敗件数として報告する。投稿一覧ページの失敗は欠落した投稿数が不明なので、投稿単位の件数とは分けて数える

### 検証境界 (ValerianDillon/download-helper#30)

検証境界は共有層の `addByPostInfo` の入口にある。拡張側の `fetchApi` 系が保証するのは収集の分岐に使うフィールドだけで、返す型は「検証済み」を名乗らない (`PostInfoCandidate` / `PostListItemCandidate`)。

本文の検証は `addByPostInfo` が行い、収集が実際に読むフィールドだけを厳密に確かめる。情報 JSON に写すだけの付随メタデータは型を検証しない (`invalid` は収集全体の中断を意味するため、読まないフィールドの型変化で全件止めない)。

アセットの `id` は必須検証になった (ValerianDillon/download-helper#41)。無いと `invalid` になり収集が止まる。

## テスト

- **テストビルド専用コードは通常ビルドに残さない。** content script は ISOLATED world で動き、Playwright (MAIN world) から状態を直接読めない。そのためテストビルドのみ `data-fbdl-*` 属性や `globalThis.__fbdlTestState` で状態を publish する
  - `--define` + dead code elimination で消え、post-build 検証が通常ビルドの成果物を fail-closed で確認する
- smoke test の責務は「FAB クリック → 収集 → ファイル取得 → ZIP 生成の完走」まで
- 分割転送 (Issue #22) は `e2e/large-media.spec.ts` が 48 MiB / 64 MiB 超のファイルを SHA-256 で照合する。50 MiB 級の fixture はリポジトリに置かずテスト実行時に生成する
- 実ファイル保存と mtime 検証は smoke test の対象外 (`showSaveFilePicker` はネイティブダイアログを要求し自動化できない)。`publishedDatetime` の mtime 反映は `test/downloader.test.ts` でカバー

### WSL2 headless の癖

- 拡張を読み込むには Playwright に `channel: 'chromium'` が要る (新しい headless 実装でのみ拡張読み込みに対応)
- WSLg の `DISPLAY` / `WAYLAND_DISPLAY` を引き継いだまま起動すると、最初の `requestAnimationFrame` の配送が 60〜100 秒止まり Playwright の stable 判定が固まる。`e2e/harness.ts` の `browserEnv()` でこの 2 つを取り除いて起動する

## 実機テスト (実 FANBOX)

ランチャーは `scripts/live-browser.ts`。起動方法・手順・診断・安全上の注意は `.claude/skills/extension-live-test/SKILL.md` が SoT。

## コーディング規約

Biome (recommended ルールセット) で強制。設定は `biome.json` が SoT。

## Git 運用

マージは squash。`main` の履歴は `<タイトル> (#42)` の形の単一コミットで揃える。
