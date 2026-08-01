---
name: extension-live-test
description: 実 FANBOX (https://www.fanbox.cc/) を相手に拡張を実ブラウザで動かし、chrome-devtools MCP から操作して実機テストを行う。fixture ベースの smoke test (e2e/) では検証できない実サイトでの挙動を確認したいときに使う。「実機テスト」「実ブラウザ」「live test」「FANBOX で実際に動かす」「本番相当で確認」といった依頼で使用する。
---

# 拡張の実機テスト (実 FANBOX)

## 責務範囲 (smoke test との住み分け)

| | `e2e/smoke.spec.ts` | この skill |
|---|---|---|
| 対象 | fixture でモックした FANBOX API | 実 FANBOX |
| 目的 | CI で毎回自動検証する回帰テスト | 実サイトでの挙動確認 (回帰検知は対象外) |
| 実行方法 | `bun run test:smoke` (自動) | ランチャー起動 + chrome-devtools MCP で手動操作 |

「fixture で完走することは確認済みだが実サイトでも動くか確認したい」ときに使う skill であり、smoke test を置き換えるものではない。

## 構成要素

- `scripts/live-browser.ts`: Playwright 管理の Chromium (channel: `chromium`) に `dist/` の拡張を読み込んだ永続コンテキストを起動し、CDP をポート公開するランチャー
- `chrome-devtools` MCP サーバ (`--browser-url` でランチャーの CDP endpoint に接続する。プロジェクトスコープで登録済み)

## 毎回のテスト手順

1. ビルド: `bun run build` (`dist/` を最新化する。テストビルドではなく通常ビルドを使う)
2. ランチャーをバックグラウンドで起動する: `bun scripts/live-browser.ts`
   - デフォルトは headless、port 9222、profile `~/.local/share/fanbox-downloader-extension/live-profile`
   - 起動確認: `curl -s http://127.0.0.1:9222/json/version` が応答するまで待つ (数秒)。応答しない場合は下記「診断」を参照
3. chrome-devtools MCP のツールで操作する
   - MCP が `http://127.0.0.1:9222` に未接続の場合は、ランチャーが起動中であることを確認した上で MCP 側を再接続する (「MCP 接続確認」参照)
   - 収集対象は 1〜2 投稿など最小限に絞る (「安全上の注意」参照)
4. 終了する: ランチャーのプロセスに SIGINT または SIGTERM を送る (`kill <pid>`)。`context.close()` が実行されプロファイルに状態が保存されてから終了する
   - 終了後、`curl -s http://127.0.0.1:9222/json/version` が応答しなくなることで停止を確認できる

## 診断 (CDP が応答しない・操作できない場合)

- ランチャーが `dist/ が見つかりません` と出力して終了した → `bun run build` を先に実行する (自動ビルドはしない設計)
- `--remote-debugging-port` のポートが既に使用中 (bind エラー) → 前回のランチャーが残っていないか `pgrep -af live-browser.ts` で確認し、残っていれば SIGTERM で止める。別ポートで動かしたい場合のみ `--port` を変える
- 同じ `--profile` を指す別プロセスが起動している → Chrome の profile ロックにより起動に失敗することがある。`pgrep -af live-browser.ts` で他のプロセスが同じ profile を使っていないか確認してから再起動する
- CDP (`/json/version`) には応答するが拡張が見当たらない → `curl -s http://127.0.0.1:<port>/json/list` を見て `"type": "service_worker"` のエントリ (`chrome-extension://.../service-worker.js`) があるか確認する。無ければ拡張の読み込み自体に失敗しているので `dist/` の中身 (`manifest.json` の有無など) を確認する

## ログイン bootstrap (初回 / セッションが切れている場合)

FANBOX のログインには CAPTCHA があるため自動化しない。ユーザに手動ログインを依頼する。

1. `bun scripts/live-browser.ts --headed` で起動する (`--profile` を明示的に指定しない限り、通常の headless 実行と同じデフォルトプロファイルを使う。これにより保存された Cookie が headless 実行時にも引き継がれる)
2. WSLg 上にウィンドウが表示されるので、ユーザに手動でログインしてもらうよう依頼する
3. ログイン完了を確認したら Ctrl+C (SIGINT) でランチャーを終了する (セッション Cookie がプロファイルに保存される)
4. 以降は通常どおり `--headed` なし (headless) で起動して使う

## フォールバック: Windows 側にウィンドウを出さず headed 実行する (未整備)

headed 起動が恒常的に必要になった場合、Xvfb 仮想ディスプレイを使えば Windows 側にウィンドウを表示せずに headed 実行できる。現時点では未整備であり、必要になったタイミングで整備する。

## MCP 接続確認 (一度だけでよい)

`claude mcp list` で `chrome-devtools` が登録されていることを確認する。未登録なら次のコマンドで登録する (ランチャーが起動している間のみ接続確認できる):

```
claude mcp add --scope local chrome-devtools -- npx chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9222
```

## 安全上の注意

- profile (`~/.local/share/fanbox-downloader-extension/live-profile`) には実セッションの Cookie が入る。リポジトリに含めない・他人と共有しない
- 実 FANBOX の API を叩く。大量ダウンロードの実行はユーザの明示的な依頼があるときのみ行う
- 収集対象は最小限 (1〜2 投稿) に絞る
- レート制限を尊重し、連続実行しない
