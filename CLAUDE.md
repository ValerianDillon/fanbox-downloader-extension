# fanbox-downloader-extension

pixiv FANBOX 一括ダウンロード Chrome 拡張 (Manifest V3)。
fanbox-downloader のブックマークレット版を Chrome 拡張に移行したもの。

## コマンド

- `bun run build` — content script + service worker をバンドルし、静的ファイルを dist/ にコピー
- `bun run build:test` — テストビルド版 (`__FBDL_TEST__=true`)、dist-test/ に出力
- `bun run lint` — Biome による静的解析・フォーマット修正
- `bun run typecheck` — tsc による型検査 (`--noEmit`。ビルドは bun build が行う)
- `bun run test` — test/ 配下のユニットテストを実行。素の `bun test` はリポジトリ全体を探索して `e2e/*.spec.ts` も拾うため使わない
- `bun run test:smoke` — dist-test/ をビルドし、Playwright で拡張の smoke test を実行

## 技術スタック

- Bun でバンドル (TypeScript → 単一 JS)、Biome で静的解析・フォーマット、Chrome Manifest V3
- 唯一の runtime 依存は `download-helper` (バージョンは package.json が SoT)。サブパスで責務が分かれる: `download-helper` が ZIP 生成、`fanbox-collector` が FANBOX 固有の収集ロジックと型、`api-session` が API のレート制御とエラー型 (後の 2 つはブックマークレット版 fanbox-downloader と共用)
- FANBOX 固有の収集ロジックと ZIP 生成本体は `download-helper` に集約されており、拡張側は service worker 経由の fetch 差し替えや FileSystemFileHandle 取得など拡張固有の処理のみを担う

## アーキテクチャ (非自明な設計判断)

- **content script + service worker の 2 プロセス構成。** content script が UI (FAB / overlay) とデータ収集と ZIP 生成を担い、service worker を fetch プロキシとして使う。content script の fetch はページ origin として扱われ downloads.fanbox.cc などが CORS でブロックされるため、host_permissions を持つ service worker 経由で取得する
- **overlay は状態マシン** `settings` → `collecting` → `downloading` → `complete`。UI は shadow DOM でページのスタイルから隔離する
- **メディア取得は Port で分割転送する (Issue #22)。** 単発の `chrome.runtime.sendMessage` の応答に本文全体を base64 で載せる方式は runtime messaging の 64 MiB 上限に base64 の 4/3 膨張込みで当たり、約 48 MiB 以上のファイルが必ず失敗していた。content script が Port を張り、service worker が本文を `CHUNK_BYTES` (8 MiB) ごとに chunk へ分けて流す。ワイヤ契約は `src/media-stream-protocol.ts` に集約し両バンドルで共有する
  - MV3 の service worker はいつでも停止しうる (30 秒無活動 / 5 分上限 / fetch 応答 30 秒)。転送途中で Port が切れたら受信済みバイト数を offset にした `Range` 要求で新しい Port を張って再開する。Range を無視して 200 が返ったら先頭から受け直し、切断が続けば `MAX_RESUMES` 回で諦めて上位の再試行に委ねる。実測 (2026-08-16) では `downloads.fanbox.cc` は Range に対応する (206 + `Accept-Ranges: bytes`) が ETag / Last-Modified を返さないため、実サイトでは validator 無しの分岐に入り Range 再開は行われず先頭からの取り直しになる (正しさは保たれ、切断時の効率のみ下がる)
  - 低速回線で `CHUNK_BYTES` が 30 秒以内に溜まらないと転送中に service worker が停止するため、chunk が満たなくても `FLUSH_INTERVAL_MS` ごとに送って idle timer をリセットする (Chrome 114 以降、Port は開くだけでなくメッセージ送受信でリセットされる)
  - 本文全体を JS ヒープに保持しない。受信合計を `Content-Length` と各 Port の終端メッセージのバイト数に突き合わせ、一致しなければ成功にしない (欠けたファイルを ZIP に入れないため)
  - API 取得 (`fetchApi`) は単発の `sendMessage` のまま (JSON はサイズ上限に達しない)
- **API のレート制御は共有層に委譲する (ValerianDillon/fanbox-downloader#3)。** ゲート・再試行・適応スロットル・直列化・エラー型は `download-helper/api-session` の `ApiSession` が持ち、拡張側 (`src/content/fanbox/api.ts`) は `Transport` の実装 (`createChromeProxyTransport`) と FANBOX 固有の URL 組み立て・レスポンス検証だけを持つ。ブックマークレット版と同じ契約・同じテストを通すため
  - transport は 3 系統を返す。`{kind:'response', status, body, retryAfter}` / 応答を得られなかった `{kind:'unobservable-failure'}` / I/O を発行しなかった `{kind:'deferred', until}`。observable な 429 と「429 かもしれない失敗」を型で分け、後者から status を推測しない
  - service worker が既知のバックオフ期限中で fetch を発行しなかった応答 (`kind: 'backoff'`) は adapter が `deferred` へ変換する。adapter の内側で待って再要求すると、セッションが実際の発行時刻を見失って基準間隔と適応間隔が抜けるため、待機と再発行はセッションが行う
  - 再試行ポリシーはセッション側にある。exact 429 は `Retry-After` を優先し、無ければ 5 / 15 / 45 秒の 3 回。観測できない失敗は 5 / 15 秒の 2 回 (レート制限以外が多く含まれるので 429 と同じ 65 秒は待たない)。429 以外の HTTP エラーは再試行しない。abort は再試行枠を消費せず即座に伝播する
  - 状態のスコープは 2 つに分かれる。基準間隔・適応間隔・再試行回数・連続成功数は収集ごと (`ApiSession` を収集ごとに作る)。サーバー指定のバックオフ期限は service worker (`chrome.storage.session`) が SoT で、タブと収集をまたぐ (Issue #16)。`api.ts` の `sharedBackoffUntil` はその参照値で、更新は `fetchApi` の応答からのみ行う。発行の前に問い合わせて取り込むことはしない (往復のぶん実際の発行が遅れ、往復の所要時間が要求ごとに違うと実発行間隔が基準間隔を下回るため)。期限の最終判定は service worker 側のゲートが持ち、そこで弾かれた応答が最新の期限を運んでくる
  - `Retry-After` の解釈は共有層の `parseRetryAfterMs` に一本化する。期限を記録する service worker と待機時間を決める共有セッションで解釈が違うと、セッションが「読めないので固定バックオフ」と判断した値を service worker が期限として記録し、その記録がタブと収集をまたいで長すぎる待機になる
  - 発行時刻は service worker が実際に `fetch` を開始した時刻 (`issuedAt`) を応答に載せ、セッションがそれを記録する (Issue #46)。セッションが自前で記録するのは `sendMessage` の直前なので、service worker の起動待ちで配送が遅れると記録と実発行がずれ、次のゲートがその遅延ぶん早く明けて実 `fetch` の間隔が有効間隔を下回りうる。報告値は別プロセス由来なので、実際の発行が起きうる区間 (`transport` 呼び出しの直前〜応答が返った時刻) に収まっていればそのまま採り、外れた値や数でない値は区間の上端 (応答が返った時刻) に倒す。区間内のどこで発行されたか分からない以上、真の発行時刻以降と確実に言えるのは上端だけで、下端 (呼び出し直前) に倒すと配送が遅れていた場合に次の発行が早まる。報告そのものが無いとき (旧 service worker、および同一プロセスで発行するブックマークレット版の transport) だけは下端を使う。記録できるのは応答を受け取れた要求だけで、送信後にキャンセルすると応答が transport に届かない (`sendMessageAbortable` が待ちを打ち切る) ため実発行時刻は記録されない。キャンセル直後の再収集が進行中の `fetch` と間隔を空けない件は Issue #49。`fetch` を発行しなかった応答 (`kind: 'backoff'`) には載せない
- **ZIP フェーズのメディア取得には 429 の制御が無く、観測だけを持つ (Issue #51)。** `fetchWithRetry` は失敗のたびに 1 秒待って再試行するだけで (呼び出しは `retries = 1` なので 1 対象につき最大 2 回)、429 と 404 / 500 を区別せず `Retry-After` も待機に使わない。収集フェーズのバックオフとも無関係で、取得先ホストも `downloads.fanbox.cc` / `*.pximg.net` と異なる
  - 制御方式を決める前に観測が要るため、試行記録 (`MediaFetchAttempt`: ホスト / ステータス / `Retry-After` / 種別 / 時刻) を `chrome.storage.local` の `fbdlMediaAttempts` に蓄積する (`src/content/media-attempt-log.ts`)。URL も投稿名も含めず、どこにも送信しない。上限 2000 件で古い方から捨てる
  - 保存は `downloadAsZip` の `finally` で行う。観測したい 429 は失敗した実行にこそ現れるので、成功時だけ保存すると最も見たい事象が落ちる
  - 読み出し・集計・削除の手順は `.claude/skills/extension-live-test/SKILL.md` が SoT
- **キャンセルは AbortController。** メディア転送では content script が Port を切断し、service worker がそれを受けて進行中の fetch を abort する。`sendMessage` 経路は signal と競争させて待ちを打ち切る (送信済みリクエスト自体は取り消せない)

## FANBOX API の扱い (落とし穴)

- 配列レスポンスは `body` 直下ではなく `body.<キー>` に入る。形状が想定と違うときに空配列へ落とすと「本当に 0 件」と区別が付かず、中身のない ZIP を完了として出してしまうので、`ApiShapeError` で中断する
- **失敗の扱いはエラー型で決まる。** 投稿単位・ページ単位の失敗として数えて続行してよいのは `HttpError` (2xx 以外の応答) だけで、それ以外を握りつぶすと実装上のバグまで通信障害として数えたまま収集が続く
  - 再試行枠の枯渇 (`RateLimitExhaustedError` / `TransportExhaustedError`) は収集全体を止める。上限まで待った直後に別のエンドポイントへ要求を出すのは、再試行上限を実質的に延長することになるため、プラン名・タグの取得中でも握りつぶさない。それまでに取り込めた投稿があれば `stoppedReason` (`rate-limit-exhausted` / `transport-exhausted`) を付けて部分保存し、1 件も無ければ例外として扱う
  - 安全に取り込めない仕様変更 (`ApiShapeError` / `ResponseParseError` / `PostBodyInvalidError`) は「未対応のレスポンス形式のため中断しました」で止める。判定は `overlay.ts` の `isUnsupportedResponseError` が SoT
  - 例外は `plan.listCreator` と `tag.getFeatured` の 2 つだけで、形状の不一致 (`ApiShapeError` / `ResponseParseError`) も HTTP エラーも握りつぶして続行する。表示の補助しか担っておらず、握りつぶしても ZIP の中身は欠けないため (枯渇だけは再送出する)
- 取得できなかった投稿は失敗件数として報告する。投稿一覧ページの失敗は欠落した投稿数が不明なので、投稿単位の件数とは分けて数える
- **検証境界は共有層の `addByPostInfo` の入口にある (ValerianDillon/download-helper#30)。** 拡張側の `fetchApi` 系が保証するのは、収集の分岐に使うフィールドだけである (`fetchPostInfo` は `id` / `type` / `isRestricted`、一覧要素は `id` / `isRestricted` / `feeRequired`)。返す型は `PostInfoCandidate` / `PostListItemCandidate` で、「検証済み」を名乗らない
  - 本文の検証は `addByPostInfo` が入口で行い、収集が実際に読むフィールドだけを厳密に確かめる。情報 JSON に写すだけの付随メタデータは型を検証しない (`invalid` は収集全体の中断を意味するため、読まないフィールドの型変化で全件止めない)
- `post.listCreator` の一覧レスポンスには本文が含まれないため、各投稿は `post.info` への追加リクエストを経て収集される
  - 一覧の時点で結果が決まる投稿 (`isRestricted`、および「無料を省く」指定に該当する `feeRequired === 0`) は `post.info` を発行せずに飛ばす。発行しても `addByPostInfo` が同じ条件で弾くだけで、レート制限の枠と待機時間を消費する。この判断に使う `id` / `isRestricted` / `feeRequired` は一覧要素の validator で検証する (欠けたまま続けると、利用者が指定した除外が無言で効かなくなる)

## テスト

- ユニットテストは `bun run test`。smoke test (Playwright, 実ブラウザ) は `bun run test:smoke`
- **テストビルド専用コードは通常ビルドに残さない。** content script は ISOLATED world で動き Playwright (MAIN world) から状態を直接読めないため、テストビルド (`__FBDL_TEST__=true`) のみ `document.documentElement` の `data-fbdl-*` 属性や service worker の `globalThis.__fbdlTestState` で状態を publish する。`scripts/build.ts` の `--define` + bun build の dead code elimination で消え、post-build 検証 (`__FBDL_TEST__` / `data-fbdl` / `__fbdlTest` の残留チェック) が通常ビルドの成果物を fail-closed で確認する
- smoke test の責務は「FAB クリック → 収集 → ファイル取得 → ZIP 生成の完走」まで。大きいファイルの分割転送 (Issue #22) は `e2e/large-media.spec.ts` が 48 MiB / 64 MiB 超のファイルを SHA-256 で照合し、Range 再開とキャンセル時の fetch 中断も検証する (50 MiB 級の fixture はリポジトリに置かずテスト実行時に生成)
- 実ファイル保存と mtime 検証は smoke test の対象外 (`showSaveFilePicker` はネイティブダイアログを要求し自動化不可、テストビルドでは in-memory stub に差し替える)。publishedDatetime の mtime 反映は `test/downloader.test.ts` でカバー
- **WSL2 headless の癖:** 拡張を読み込むには Playwright に `channel: 'chromium'` が要る (新しい headless 実装でのみ拡張読み込みに対応)。また WSLg の `DISPLAY` / `WAYLAND_DISPLAY` を引き継いだまま起動すると最初の `requestAnimationFrame` の配送が 60〜100 秒止まり、Playwright の stable 判定が固まってタイムアウトするため、`e2e/harness.ts` の `browserEnv()` でこの 2 つを取り除いて起動する

## 実機テスト (実 FANBOX)

- 実 FANBOX に対して拡張を動かすランチャーが `scripts/live-browser.ts` にある。起動方法・手順・診断・安全上の注意は `.claude/skills/extension-live-test/SKILL.md` が SoT

## コーディング規約

- Biome (recommended ルールセット) で強制。設定は `biome.json` が SoT

## Git 運用

- マージは squash。`main` の履歴は `<タイトル> (#42)` の形の単一コミットで揃える
