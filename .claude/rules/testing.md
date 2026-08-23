---
paths:
  - 'e2e/**/*.ts'
  - 'test/**/*.ts'
  - 'scripts/build.ts'
  - 'src/content/test-hooks.ts'
  - 'src/service-worker/test-hooks.ts'
---

# テスト

- **テストビルド専用コードは通常ビルドに残さない。** content script は ISOLATED world で動き、Playwright (MAIN world) から状態を直接読めない。そのためテストビルドのみ `data-fbdl-*` 属性や `globalThis.__fbdlTestState` で状態を publish する
  - `--define` + dead code elimination で消え、post-build 検証が通常ビルドの成果物を fail-closed で確認する
- smoke test の責務は「FAB クリック → 収集 → ファイル取得 → ZIP 生成の完走」まで
- 分割転送 (Issue #22) は `e2e/large-media.spec.ts` が 48 MiB / 64 MiB 超のファイルを SHA-256 で照合する。50 MiB 級の fixture はリポジトリに置かずテスト実行時に生成する
- 実ファイル保存と mtime 検証は smoke test の対象外 (`showSaveFilePicker` はネイティブダイアログを要求し自動化できない)。`publishedDatetime` の mtime 反映は `test/downloader.test.ts` でカバー

## WSL2 headless の癖

- 拡張を読み込むには Playwright に `channel: 'chromium'` が要る (新しい headless 実装でのみ拡張読み込みに対応)
- WSLg の `DISPLAY` / `WAYLAND_DISPLAY` を引き継いだまま起動すると、最初の `requestAnimationFrame` の配送が 60〜100 秒止まり Playwright の stable 判定が固まる。`e2e/harness.ts` の `browserEnv()` でこの 2 つを取り除いて起動する
