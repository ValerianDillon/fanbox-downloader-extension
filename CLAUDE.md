# fanbox-downloader-extension

pixiv FANBOX 一括ダウンロード Chrome 拡張 (Manifest V3)。
fanbox-downloader のブックマークレット版を Chrome 拡張に移行したもの。

## コマンド

- `bun run build` — content script + service worker をバンドルし、静的ファイルを dist/ にコピー
- `bun run build:test` — 上記のテストビルド版 (`__FBDL_TEST__=true`)、dist-test/ に出力
- `bun run lint` — Biome による静的解析・フォーマット修正
- `bun run typecheck` — tsc による型検査 (ビルドは bun build が行うため `--noEmit`)
- `bun run test` (= `bun test test`) — test/ 配下のユニットテストを実行 (e2e/ は対象外)。素の `bun test` はリポジトリ全体を探索して `e2e/*.spec.ts` も拾うため使わない
- `bun run test:smoke` — dist-test/ をビルドし、Playwright で拡張の smoke test を実行

## プロジェクト構成

```
scripts/
  build.ts                # ビルド本体 (bun scripts/build.ts [--test])
  live-browser.ts          # 実 FANBOX での実機テスト用ランチャー (詳細は .claude/skills/extension-live-test/)
src/
  types.d.ts               # __FBDL_TEST__ (ビルド時 define 定数) の型宣言
  content/
    content.ts             # entry point: ページ検出, SPA 対応
    fab.ts                 # FAB ボタン (shadow DOM)
    overlay.ts             # オーバーレイパネル (shadow DOM)
    overlay.css            # overlay スタイル (FAB のスタイルは fab.ts の FAB_STYLES)
    downloader.ts          # download-helper への薄いアダプタ (メディア取得, ハンドル取得)
    media-stream.ts        # メディア本文を Port で chunk 受信し Blob に組み立てる (Issue #22。切断時は Range で再開)
    messaging.ts           # service worker との messaging を AbortSignal 対応にするラッパー (fetchApi / getBackoffUntil 用)
    test-hooks.ts          # __FBDL_TEST__ 専用の観測フック (data-fbdl-* 属性 publish)
    fanbox/
      api.ts               # FANBOX API クライアント (async fetch)
      collector.ts         # データ収集 (searchBy 相当, addByPostInfo は download-helper から利用)
  media-stream-protocol.ts # メディア分割転送の Port プロトコル (両バンドル共有のワイヤ契約, Issue #22)
  service-worker/
    service-worker.ts      # lifecycle + fetchApi プロキシ + メディア転送の Port 受け口 (CORS 回避)
    media-stream.ts        # メディアを fetch し Port に chunk で流す本体 (Issue #22)
    test-hooks.ts          # __FBDL_TEST__ 専用の観測フック (globalThis.__fbdlTestState, 切断シミュレーション)
test/
  fanbox/
    api.test.ts            # detectPage / レート制限 / レスポンス形状のテスト
    collector.test.ts      # 収集フローと失敗件数の数え分けのテスト
  overlay.test.ts          # 状態遷移テスト
  messaging.test.ts        # sendMessageAbortable の中断テスト
  downloader.test.ts       # downloadAsZip (publishedDatetime の mtime 反映) テスト
  media-stream.test.ts     # content 側の Port 受信 (chunk 結合 / Range 再開 / 整合性検証) テスト
  fake-media-port.ts       # メディア Port のフェイク (media-stream.test.ts / downloader.test.ts 共用)
  service-worker/
    media-stream.test.ts   # service worker 側の分割転送 (streamMedia) テスト
e2e/
  smoke.spec.ts            # 基本フローの smoke test (Playwright, WSL headless 対応)
  large-media.spec.ts      # 大きいファイルの分割転送 smoke test (Issue #22)
  harness.ts               # smoke test 共通のセットアップ (拡張起動 / API モック / 状態読み取り)
  fixtures.ts              # FANBOX API レスポンス fixture
  zip-util.ts              # smoke test 用の最小 ZIP パーサ (Central Directory / EOCD)
static/
  manifest.json
  icons/
dist/                      # ビルド成果物 (git 管理対象外)
dist-test/                 # テストビルド成果物 (git 管理対象外, smoke test が読み込む)
```

## 技術スタック

- Bun でバンドル (TypeScript → 単一 JS)
- Biome で静的解析・フォーマット
- Chrome Manifest V3
- 唯一の runtime 依存: `download-helper` (`github:ValerianDillon/download-helper#v4.3.0`)
  - `download-helper/download-helper`: `DownloadHelper.downloadZip` (ZIP 生成本体), `DownloadUtils`, `ZipWriter` など
  - `download-helper/fanbox-collector`: FANBOX API 型定義 (`PostInfo` 等), `DownloadManage`, `addByPostInfo`, `convert*Map` など FANBOX 固有の共通ロジック (fanbox-downloader と共用)

## アーキテクチャ

- content script + service worker 構成
  - content script: UI (FAB / overlay) + データ収集 + ZIP 生成
  - service worker: fetch プロキシ (host_permissions で CORS 回避)
- FAB ボタンをページに挿入 → overlay パネルで設定 → データ収集 → ZIP ダウンロード
- overlay は状態マシン: `settings` → `collecting` → `downloading` → `complete`
- FANBOX API の配列レスポンスは `body` 直下ではなく `body.<キー>` に入る。形状が想定と違うとき、プラン名とタグは表示の補助なので握りつぶして続行し、投稿一覧と投稿詳細は `ApiShapeError` で中断する (空配列に落とすと「本当に 0 件だった」と区別が付かず、中身のない ZIP を完了として出してしまうため)
- 取得できなかった投稿は失敗件数として報告する。投稿一覧ページの失敗は欠落した投稿数が不明なので、投稿単位の件数とは分けて数える
- API 取得 (`fetchApi` / `getBackoffUntil`) は単発の `chrome.runtime.sendMessage` を使う (`src/content/messaging.ts`)
- メディア取得 (downloads.fanbox.cc / *.pximg.net) は Port で分割転送する (Issue #22)。単発メッセージの応答に本文全体を base64 で載せる方式は runtime messaging の 64 MiB 上限に base64 の 4/3 膨張込みで当たり、約 48 MiB 以上のファイルが必ず失敗していた。content script が Port を張り (`src/content/media-stream.ts`)、service worker が本文を `CHUNK_BYTES` (8 MiB) ごとに chunk へ分けて流す (`src/service-worker/media-stream.ts`)。ワイヤ契約は `src/media-stream-protocol.ts` に集約し両バンドルで共有する
  - MV3 の service worker はいつでも停止しうる (30 秒無活動 / 5 分上限 / fetch 応答 30 秒)。転送途中で Port が切れたら content script は受信済みバイト数を offset にした `Range` 要求で新しい Port を張って再開する。サーバが Range を無視して 200 を返したら先頭から受け直す。切断が続けば `MAX_RESUMES` 回で諦めて失敗として上位の再試行に委ねる
  - 低速回線で `CHUNK_BYTES` が 30 秒以内に溜まらないと転送中に service worker が停止するため、chunk が満たなくても `FLUSH_INTERVAL_MS` (2 秒) ごとに送って idle timer をリセットする (Chrome 114 以降、Port は開くだけでなくメッセージ送受信でリセットされる)
  - 本文全体はどちらの側の JS ヒープにも保持しない。service worker は chunk 1 つぶん、content script は chunk ごとに Blob 化して最後に結合する。受信合計を `Content-Length` と各 Port の `end.bytes` に突き合わせ、一致しなければ成功にしない (欠けたファイルを ZIP に入れない)
- AbortController によるキャンセル対応。キャンセル時は content script が Port を切断し、service worker はそれを受けて進行中の fetch を abort する (`chrome.runtime.sendMessage` 経路は従来どおり signal と競争させる)
- SPA ナビゲーション対応 (pushState/replaceState フック)
- shadow DOM でスタイル隔離
- FANBOX 固有の収集ロジックと ZIP 生成本体 (downloadZip) は `download-helper` に集約されており、拡張側は service worker 経由の fetch 差し替えや FileSystemFileHandle 取得など拡張固有の処理のみを担う

## smoke test (Playwright)

- `bun run test:smoke` で実行する。
- content script は ISOLATED world で動くため、Playwright 側 (MAIN world) から直接状態を読めない。
- そのためテストビルド (`__FBDL_TEST__=true`) のみ、`document.documentElement` の `data-fbdl-*` 属性経由で状態を publish する (`src/content/test-hooks.ts`)。
- `scripts/build.ts` の `--define __FBDL_TEST__` と bun build の dead code elimination により、テスト専用コードは通常ビルド (dist/) には一切残らない。
- 通常ビルドは `scripts/build.ts` の末尾で dist/content.js と dist/service-worker.js を読み、`__FBDL_TEST__` / `data-fbdl` / `__fbdlTest` の残留がないかを post-build 検証として自動チェックし、検出時はビルドを失敗させる (`__fbdlTest` は service worker 側の観測フック `src/service-worker/test-hooks.ts` の残留チェック)。
- テストビルドでは shadow root を `open` にし (通常は `closed`)、`showSaveFilePicker` を in-memory な stub に差し替える。stub の close() 時に ZIP を Blob URL (`data-fbdl-zip-url`) とサイズ (`data-fbdl-zip-size`) として publish する。8 MiB 以下なら base64 (`data-fbdl-zip-b64`) も publish するが、大きい ZIP は Blob URL を `page.evaluate` から fetch して検証する (数十 MiB の base64 を DOM 属性で運ばないため)。
- 基本フローの smoke test (`e2e/smoke.spec.ts`) の責務範囲は「FAB クリック → データ収集 → 全ファイル取得成功 → ZIP 生成の完走」までである。
- 大きいファイルの分割転送 (Issue #22) は `e2e/large-media.spec.ts` でカバーする。48 MiB (従来の失敗境界) / 64 MiB 超のファイルが複数 chunk で欠落なく ZIP に入ること (SHA-256 で照合)、転送途中の切断からの Range 再開、キャンセル時に service worker 側の fetch も止まることを実ブラウザで検証する。50 MiB 級の fixture はリポジトリに置かず、決定的な擬似乱数でテスト実行時に生成する。service worker 側の観測は `globalThis.__fbdlTestState` (テストビルドのみ) を Playwright の `Worker.evaluate` で読む。切断シミュレーションは URL の `fbdl-test-drop-after=<bytes>` クエリで駆動する。
- 実ファイルへの保存とその mtime の検証は対象外である。
- `showSaveFilePicker` はネイティブのファイル選択ダイアログを要求するため、ブラウザ自動化では扱えない。
- publishedDatetime の ZIP エントリへの反映は `test/downloader.test.ts` (ユニットテスト) でカバー済みである。
- 共通のセットアップ (拡張プロファイル起動 / FANBOX API モック / テスト状態の読み取り) は `e2e/harness.ts` に集約し、各 spec から使う。`e2e/fixtures.ts` は FANBOX API レスポンス fixture、`e2e/zip-util.ts` は ZIP の Central Directory / EOCD を読む最小パーサである。
- fixture は投稿を 2 件用意している。投稿A は image type の無料投稿、投稿B は file type の有料投稿である。
- `post.listCreator` の一覧レスポンスには本文が含まれないため、どちらの投稿も `post.info` への追加リクエストを経て収集される。
- WSL2 上の headless Chromium で拡張を読み込むには `channel: 'chromium'` の指定が必要である (新しい headless 実装でのみ拡張の読み込みに対応するため)。
- WSLg の `DISPLAY` / `WAYLAND_DISPLAY` を引き継いだまま headless Chromium を起動すると、最初の `requestAnimationFrame` の配送が 60〜100 秒止まる (2 フレーム目以降は 16ms で正常)。Playwright の actionability の stable 判定が連続 2 フレームの bounding box 比較を待つため、最初の操作がそこで固まって既定の 60 秒タイムアウトを超える。`browserEnv()` でこの 2 つを取り除いて起動している。

## 実機テスト (実 FANBOX)

- `scripts/live-browser.ts` は fixture ではなく実 FANBOX (https://www.fanbox.cc/) に対して拡張を動かすためのランチャーである (`bun scripts/live-browser.ts [--headed] [--port <n>] [--profile <dir>]`)。CDP をポート公開し、`chrome-devtools` MCP から操作する想定。
- 手順・診断・安全上の注意は `.claude/skills/extension-live-test/SKILL.md` を参照。

## コーディング規約

- Biome (recommended ルールセット) で強制。設定は `biome.json` に記載
- インデント: スペース2つ
- シングルクォート、セミコロンあり、末尾カンマあり
- `lineWidth: 120`

## Git 運用

- リモート `origin`: ValerianDillon/fanbox-downloader-extension
- コミットの author/committer は ValerianDillon であること
