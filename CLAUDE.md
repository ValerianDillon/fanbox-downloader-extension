# fanbox-downloader-extension

pixiv FANBOX 一括ダウンロード Chrome 拡張 (Manifest V3)。
fanbox-downloader のブックマークレット版を Chrome 拡張に移行したもの。

## コマンド

- `bun run build` — content script + service worker をバンドルし、静的ファイルを dist/ にコピー
- `bun run build:test` — 上記のテストビルド版 (`__FBDL_TEST__=true`)、dist-test/ に出力
- `bun run lint` — Biome による静的解析・フォーマット修正
- `bun test` (= `bun run test`) — test/ 配下のユニットテストを実行 (e2e/ は対象外)
- `bun run test:smoke` — dist-test/ をビルドし、Playwright で拡張の smoke test を実行

## プロジェクト構成

```
scripts/
  build.ts                # ビルド本体 (bun scripts/build.ts [--test])
src/
  types.d.ts               # __FBDL_TEST__ (ビルド時 define 定数) の型宣言
  content/
    content.ts             # entry point: ページ検出, SPA 対応
    fab.ts                 # FAB ボタン (shadow DOM)
    overlay.ts             # オーバーレイパネル (shadow DOM)
    overlay.css            # FAB + overlay スタイル
    downloader.ts          # download-helper への薄いアダプタ (service worker 経由 fetch, ハンドル取得)
    test-hooks.ts          # __FBDL_TEST__ 専用の観測フック (data-fbdl-* 属性 publish)
    fanbox/
      api.ts               # FANBOX API クライアント (async fetch)
      collector.ts         # データ収集 (searchBy 相当, addByPostInfo は download-helper から利用)
  service-worker/
    service-worker.ts      # lifecycle + fetch プロキシ (CORS 回避)
test/
  fanbox/
    api.test.ts            # detectPage テスト
  overlay.test.ts          # 状態遷移テスト
  downloader.test.ts       # downloadAsZip (publishedDatetime の mtime 反映) テスト
e2e/
  smoke.spec.ts            # 拡張の smoke test (Playwright, WSL headless 対応)
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
- 唯一の runtime 依存: `download-helper` (`github:ValerianDillon/download-helper#v3.7.0`)
  - `download-helper/download-helper`: `DownloadHelper.downloadZip` (ZIP 生成本体), `DownloadUtils`, `ZipWriter` など
  - `download-helper/fanbox-collector`: FANBOX API 型定義 (`PostInfo` 等), `DownloadManage`, `addByPostInfo`, `convert*Map` など FANBOX 固有の共通ロジック (fanbox-downloader と共用)

## アーキテクチャ

- content script + service worker 構成
  - content script: UI (FAB / overlay) + データ収集 + ZIP 生成
  - service worker: fetch プロキシ (host_permissions で CORS 回避、ArrayBuffer → base64 変換)
- FAB ボタンをページに挿入 → overlay パネルで設定 → データ収集 → ZIP ダウンロード
- overlay は状態マシン: `settings` → `collecting` → `downloading` → `complete`
- AbortController によるキャンセル対応
- SPA ナビゲーション対応 (pushState/replaceState フック)
- shadow DOM でスタイル隔離
- FANBOX 固有の収集ロジックと ZIP 生成本体 (downloadZip) は `download-helper` に集約されており、拡張側は service worker 経由の fetch 差し替えや FileSystemFileHandle 取得など拡張固有の処理のみを担う

## smoke test (Playwright)

- `bun run test:smoke` で実行する。
- content script は ISOLATED world で動くため、Playwright 側 (MAIN world) から直接状態を読めない。
- そのためテストビルド (`__FBDL_TEST__=true`) のみ、`document.documentElement` の `data-fbdl-*` 属性経由で状態を publish する (`src/content/test-hooks.ts`)。
- `scripts/build.ts` の `--define __FBDL_TEST__` と bun build の dead code elimination により、テスト専用コードは通常ビルド (dist/) には一切残らない。
- 通常ビルドは `scripts/build.ts` の末尾で dist/content.js と dist/service-worker.js を読み、`__FBDL_TEST__` / `data-fbdl` の残留がないかを post-build 検証として自動チェックし、検出時はビルドを失敗させる。
- テストビルドでは shadow root を `open` にし (通常は `closed`)、`showSaveFilePicker` を in-memory な stub に差し替える。
- smoke test の責務範囲は「FAB クリック → データ収集 → 全ファイル取得成功 → ZIP 生成の完走」までである。
- 実ファイルへの保存とその mtime の検証は対象外である。
- `showSaveFilePicker` はネイティブのファイル選択ダイアログを要求するため、ブラウザ自動化では扱えない。
- publishedDatetime の ZIP エントリへの反映は `test/downloader.test.ts` (ユニットテスト) でカバー済みである。
- テスト構成は `e2e/smoke.spec.ts` (本体)、`e2e/fixtures.ts` (FANBOX API レスポンス fixture)、`e2e/zip-util.ts` (ZIP の Central Directory / EOCD を読む最小パーサ) の 3 ファイルからなる。
- fixture は投稿を 2 件用意している。投稿A は image type の無料投稿、投稿B は file type の有料投稿である。
- `post.listCreator` の一覧レスポンスには本文が含まれないため、どちらの投稿も `post.info` への追加リクエストを経て収集される。
- WSL2 上の headless Chromium で拡張を読み込むには `channel: 'chromium'` の指定が必要である (新しい headless 実装でのみ拡張の読み込みに対応するため)。

## コーディング規約

- Biome (recommended ルールセット) で強制。設定は `biome.json` に記載
- インデント: スペース2つ
- シングルクォート、セミコロンあり、末尾カンマあり
- `lineWidth: 120`

## Git 運用

- リモート `origin`: ValerianDillon/fanbox-downloader-extension
- コミットの author/committer は ValerianDillon であること
