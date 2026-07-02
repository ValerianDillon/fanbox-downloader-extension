import { defineConfig } from '@playwright/test';

/**
 * Issue #10: 拡張の smoke test 用設定。
 *
 * - testDir: e2e/ 配下の *.spec.ts のみを対象にする (bun test の対象からは外れる)
 * - workers: 1 (拡張の永続コンテキストを複数並列で立てると不安定なため直列実行)
 * - `bun run test:smoke` は `bun run build:test` (dist-test/ 生成) を先に実行してから
 *   このコンフィグで playwright test を起動する
 */
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
});
