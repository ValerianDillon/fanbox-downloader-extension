# fanbox-downloader-extension

pixiv FANBOX 一括ダウンロード Chrome 拡張 (Manifest V3)。ブックマークレット版 fanbox-downloader を移行したもの。

FANBOX 固有の収集ロジックと ZIP 生成は `download-helper` に集約されている。拡張が担うのは、service worker 経由の fetch 差し替えや `FileSystemFileHandle` 取得など拡張固有の処理だけ。

## コマンド

- `bun run build` — content script + service worker をバンドルし、静的ファイルを `dist/` にコピー
- `bun run build:test` — テストビルド版 (`__FBDL_TEST__=true`) を `dist-test/` に出力
- `bun run lint` / `bun run typecheck`
- `bun run test` — `test/` 配下のユニットテスト。**素の `bun test` は使わない** (リポジトリ全体を探索して `e2e/*.spec.ts` も拾う)。単一ファイルやディレクトリだけ走らせたいときは `bun run test <path>`
- `bun run test:smoke` — `dist-test/` をビルドし、Playwright で smoke test を実行

## プロセス構成

**content script + service worker の 2 プロセス。** content script が UI (FAB / overlay) とデータ収集と ZIP 生成を担い、service worker を fetch プロキシとして使う。

content script の fetch はページ origin として扱われ、`downloads.fanbox.cc` などが CORS でブロックされる。host_permissions を持つ service worker 経由で取得する必要がある。

overlay は状態マシン (`settings` → `collecting` → `review` → `downloading` → `complete`)。UI は shadow DOM でページのスタイルから隔離する。

キャンセルは AbortController。メディア転送では content script が Port を切断し、service worker がそれを受けて進行中の fetch を abort する。`sendMessage` 経路は signal と競争させて待ちを打ち切る (送信済みリクエスト自体は取り消せない)。

## 設計の背景をどこに書くか

「なぜその形にしたか」は共有ruleである `.claude/rules/` に置き、ここには重複させない。
Claude Codeは対象ファイルを読むとpath-scoped ruleを自動読込する。
Codexはファイルを編集する前に、各ruleのYAML frontmatterにある `paths` を照合し、該当するruleをすべて読んで従う。

| ルール | 対象 |
| --- | --- |
| `overlay.md` | review 画面、AbortController の世代、`showSaveFilePicker` の位置 |
| `archive-path.md` | archive path の採番と名前の規則 |
| `history.md` | 差分ダウンロードの履歴の永続化 |
| `media-stream.md` | メディア取得の分割転送 |
| `api-rate-limit.md` | API のレート制御 |
| `media-attempts.md` | ZIP フェーズのメディア取得の観測記録 |
| `fanbox-api.md` | FANBOX API の落とし穴と失敗の扱い |
| `testing.md` | テストの方針と WSL2 headless の癖 |

実装の細部の根拠はコード内の JSDoc が SoT。ルールと重複させない。

## 実機テスト (実 FANBOX)

ランチャーは `scripts/live-browser.ts`。
起動方法・手順・診断・安全上の注意は `.claude/skills/extension-live-test/SKILL.md` が共有SoTであり、Codexからは `.agents/skills/extension-live-test/SKILL.md` を入口として利用する。

## コーディング規約

Biome (recommended ルールセット) で強制。設定は `biome.json` が SoT。

## Git 運用

マージは squash。`main` の履歴は `<タイトル> (#42)` の形の単一コミットで揃える。
