# fanbox-downloader-extension

pixiv FANBOX 一括ダウンロード Chrome 拡張 (Manifest V3)。
fanbox-downloader のブックマークレット版を Chrome 拡張に移行したもの。

## コマンド

- `bun run build` — content script + service worker をバンドルし、静的ファイルを dist/ にコピー
- `bun run lint` — Biome による静的解析・フォーマット修正
- `bun test` — テスト実行

## プロジェクト構成

```
src/
  content/
    content.ts              # entry point: ページ検出, SPA 対応
    fab.ts                  # FAB ボタン (shadow DOM)
    overlay.ts              # オーバーレイパネル (shadow DOM)
    overlay.css             # FAB + overlay スタイル
    downloader.ts           # download-helper への薄いアダプタ (service worker 経由 fetch, ハンドル取得)
    fanbox/
      api.ts                # FANBOX API クライアント (async fetch)
      collector.ts          # データ収集 (searchBy 相当, addByPostInfo は download-helper から利用)
  service-worker/
    service-worker.ts       # lifecycle + fetch プロキシ (CORS 回避)
test/
  fanbox/
    api.test.ts             # detectPage テスト
  overlay.test.ts           # 状態遷移テスト
  downloader.test.ts        # downloadAsZip (publishedDatetime の mtime 反映) テスト
static/
  manifest.json
  icons/
dist/                       # ビルド成果物 (git 管理対象外)
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

## コーディング規約

- Biome (recommended ルールセット) で強制。設定は `biome.json` に記載
- インデント: スペース2つ
- シングルクォート、セミコロンあり、末尾カンマあり
- `lineWidth: 120`

## Git 運用

- リモート `origin`: ValerianDillon/fanbox-downloader-extension
- コミットの author/committer は ValerianDillon であること
