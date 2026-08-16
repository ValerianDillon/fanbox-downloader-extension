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
- 唯一の runtime 依存は `download-helper` (バージョンは package.json が SoT)
  - `download-helper/download-helper`: `DownloadHelper.downloadZip` (ZIP 生成本体), `DownloadUtils`, `ZipWriter`
  - `download-helper/fanbox-collector`: FANBOX API 型定義, `addByPostInfo` など FANBOX 固有の共通ロジック (ブックマークレット版 fanbox-downloader と共用)
- FANBOX 固有の収集ロジックと ZIP 生成本体は `download-helper` に集約されており、拡張側は service worker 経由の fetch 差し替えや FileSystemFileHandle 取得など拡張固有の処理のみを担う

## アーキテクチャ (非自明な設計判断)

- **content script + service worker の 2 プロセス構成。** content script が UI (FAB / overlay) とデータ収集と ZIP 生成を担い、service worker を fetch プロキシとして使う。content script の fetch はページ origin として扱われ downloads.fanbox.cc などが CORS でブロックされるため、host_permissions を持つ service worker 経由で取得する
- **overlay は状態マシン** `settings` → `collecting` → `downloading` → `complete`。UI は shadow DOM でページのスタイルから隔離する
- **メディア取得は Port で分割転送する (Issue #22)。** 単発の `chrome.runtime.sendMessage` の応答に本文全体を base64 で載せる方式は runtime messaging の 64 MiB 上限に base64 の 4/3 膨張込みで当たり、約 48 MiB 以上のファイルが必ず失敗していた。content script が Port を張り、service worker が本文を `CHUNK_BYTES` (8 MiB) ごとに chunk へ分けて流す。ワイヤ契約は `src/media-stream-protocol.ts` に集約し両バンドルで共有する
  - MV3 の service worker はいつでも停止しうる (30 秒無活動 / 5 分上限 / fetch 応答 30 秒)。転送途中で Port が切れたら受信済みバイト数を offset にした `Range` 要求で新しい Port を張って再開する。Range を無視して 200 が返ったら先頭から受け直し、切断が続けば `MAX_RESUMES` 回で諦めて上位の再試行に委ねる。実測 (2026-08-16) では `downloads.fanbox.cc` は Range に対応する (206 + `Accept-Ranges: bytes`) が ETag / Last-Modified を返さないため、実サイトでは validator 無しの分岐 (`src/content/media-stream.ts:142`) に入り Range 再開は行われず先頭からの取り直しになる (正しさは保たれ、切断時の効率のみ下がる)
  - 低速回線で `CHUNK_BYTES` が 30 秒以内に溜まらないと転送中に service worker が停止するため、chunk が満たなくても `FLUSH_INTERVAL_MS` ごとに送って idle timer をリセットする (Chrome 114 以降、Port は開くだけでなくメッセージ送受信でリセットされる)
  - 本文全体を JS ヒープに保持しない。受信合計を `Content-Length` と各 Port の終端メッセージのバイト数に突き合わせ、一致しなければ成功にしない (欠けたファイルを ZIP に入れないため)
  - API 取得 (`fetchApi` / `getBackoffUntil`) は単発の `sendMessage` のまま (JSON はサイズ上限に達しない)
- **キャンセルは AbortController。** メディア転送では content script が Port を切断し、service worker がそれを受けて進行中の fetch を abort する。`sendMessage` 経路は signal と競争させて待ちを打ち切る (送信済みリクエスト自体は取り消せない)

## FANBOX API の扱い (落とし穴)

- 配列レスポンスは `body` 直下ではなく `body.<キー>` に入る。形状が想定と違うとき、プラン名とタグは表示の補助なので握りつぶして続行し、投稿一覧と投稿詳細は `ApiShapeError` で中断する (空配列に落とすと「本当に 0 件」と区別が付かず、中身のない ZIP を完了として出してしまうため)
- 取得できなかった投稿は失敗件数として報告する。投稿一覧ページの失敗は欠落した投稿数が不明なので、投稿単位の件数とは分けて数える
- `post.listCreator` の一覧レスポンスには本文が含まれないため、各投稿は `post.info` への追加リクエストを経て収集される

## テスト

- ユニットテストは `bun run test`。smoke test (Playwright, 実ブラウザ) は `bun run test:smoke`
- **テストビルド専用コードは通常ビルドに残さない。** content script は ISOLATED world で動き Playwright (MAIN world) から状態を直接読めないため、テストビルド (`__FBDL_TEST__=true`) のみ `document.documentElement` の `data-fbdl-*` 属性や service worker の `globalThis.__fbdlTestState` で状態を publish する。`scripts/build.ts` の `--define` + bun build の dead code elimination で消え、post-build 検証 (`__FBDL_TEST__` / `data-fbdl` / `__fbdlTest` の残留チェック) が通常ビルドの成果物を fail-closed で確認する
- smoke test の責務は「FAB クリック → 収集 → ファイル取得 → ZIP 生成の完走」まで。大きいファイルの分割転送 (Issue #22) は `e2e/large-media.spec.ts` が 48 MiB / 64 MiB 超のファイルを SHA-256 で照合し、Range 再開とキャンセル時の fetch 中断も検証する (50 MiB 級の fixture はリポジトリに置かずテスト実行時に生成)
- 実ファイル保存と mtime 検証は smoke test の対象外 (`showSaveFilePicker` はネイティブダイアログを要求し自動化不可、テストビルドでは in-memory stub に差し替える)。publishedDatetime の mtime 反映は `test/downloader.test.ts` でカバー
- **WSL2 headless の癖:** 拡張を読み込むには Playwright に `channel: 'chromium'` が要る (新しい headless 実装でのみ拡張読み込みに対応)。また WSLg の `DISPLAY` / `WAYLAND_DISPLAY` を引き継いだまま起動すると最初の `requestAnimationFrame` の配送が 60〜100 秒止まり、Playwright の stable 判定が固まってタイムアウトするため、`e2e/harness.ts` の `browserEnv()` でこの 2 つを取り除いて起動する

## 実機テスト (実 FANBOX)

- `scripts/live-browser.ts` は fixture ではなく実 FANBOX に対して拡張を動かすランチャー (`bun scripts/live-browser.ts [--headed] [--port <n>] [--profile <dir>]`)。CDP をポート公開し `chrome-devtools` MCP から操作する想定
- 手順・診断・安全上の注意は `.claude/skills/extension-live-test/SKILL.md` を参照

## コーディング規約

- Biome (recommended ルールセット) で強制。設定は `biome.json` (インデント スペース 2、シングルクォート、セミコロンあり、末尾カンマあり、`lineWidth: 120`)

## Git 運用

- リモート `origin`: ValerianDillon/fanbox-downloader-extension
- コミットの author/committer は ValerianDillon であること
