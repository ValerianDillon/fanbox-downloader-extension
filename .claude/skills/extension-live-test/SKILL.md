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

## 拡張の操作レシピ

1. 対象クリエイターのページ (`https://www.fanbox.cc/@<creatorId>` または `<creatorId>.fanbox.cc`) を開く
2. 拡張の FAB ボタン (画面右下 `bottom: 24px; right: 24px` に固定表示、`src/content/fab.ts`) をクリックする。通常ビルドの shadow root は closed のため DOM セレクタでは shadow 内に届かない。スクリーンショットを撮って座標クリックするか、accessibility snapshot にボタンが出ていればそれを使う
3. overlay パネルで収集対象を最小限 (1〜2 投稿) に設定して実行し、進行は overlay の表示で確認する
4. 保存ステップ (`showSaveFilePicker`, `src/content/downloader.ts:69`) はネイティブのファイル保存ダイアログを要求するため、headless では完走できない可能性が高い (未検証)。headless での確認は収集完了までを責務範囲とし、保存まで確認したい場合は headed で行う

## 診断 (CDP が応答しない・操作できない場合)

- ランチャーが `dist/ が見つかりません` と出力して終了した → `bun run build` を先に実行する (自動ビルドはしない設計)
- `--remote-debugging-port` のポートが既に使用中 (bind エラー) → 前回のランチャーが残っていないか `pgrep -af live-browser.ts` で確認し、残っていれば SIGTERM で止める。無関係なプロセスが占有している場合は勝手に kill せず、「ポートを変更する場合」(下記 MCP 接続確認の節) に従って別ポートで起動する
- 同じ `--profile` を指す別プロセスが起動している → Chrome の profile ロックにより起動に失敗することがある。`pgrep -af live-browser.ts` で他のプロセスが同じ profile を使っていないか確認してから再起動する
- CDP (`/json/version`) には応答するが拡張が見当たらない → `curl -s http://127.0.0.1:<port>/json/list` を見て `"type": "service_worker"` のエントリ (`chrome-extension://.../service-worker.js`) があるか確認する。無ければ拡張の読み込み自体に失敗しているので `dist/` の中身 (`manifest.json` の有無など) を確認する

## ログイン bootstrap (初回 / セッションが切れている場合)

FANBOX のログインには CAPTCHA があるため自動化しない。ユーザに手動ログインを依頼する。

1. `bun scripts/live-browser.ts --headed` で起動する (`--profile` を明示的に指定しない限り、通常の headless 実行と同じデフォルトプロファイルを使う。これにより保存された Cookie が headless 実行時にも引き継がれる)
2. WSLg 上にウィンドウが表示されるので、ユーザに手動でログインしてもらうよう依頼する
3. ログイン完了を確認したら Ctrl+C (SIGINT) でランチャーを終了する (セッション Cookie がプロファイルに保存される)
4. 以降は通常どおり `--headed` なし (headless) で起動して使う

### agent のシェルから headed 起動に失敗する場合

agent の実行シェルには WSLg の X 認証が引き継がれないことがあり、`DISPLAY` が設定されていても `Missing X server or $DISPLAY` で headed 起動に失敗する (`XAUTHORITY` 未設定、または WSLg の X サーバ自体が無応答)。この失敗は環境要因であり、スクリプトや拡張の不具合ではない。

- 同じ起動を繰り返さない。1 回失敗したら切り分け (`timeout 5 xset q` の応答有無) をして止める
- ユーザに、**agent のシェルではなくユーザ自身のターミナル**で `bun scripts/live-browser.ts --headed` を実行して手順 2〜3 (ログイン → Ctrl+C) を行うよう依頼する。プロファイルは同じ場所を使うため、完了後は agent 側から headless で Cookie を利用できる
- ユーザのターミナルでもウィンドウが出ない場合は WSLg 自体の不調の可能性がある (`wsl --shutdown` からの再起動をユーザに提案する。agent のセッションも道連れになるため、実行前に作業を push しておく)

## フォールバック: Windows 側にウィンドウを出さず headed 実行する (未整備)

headed 起動が恒常的に必要になった場合、Xvfb 仮想ディスプレイを使えば Windows 側にウィンドウを表示せずに headed 実行できる。現時点では未整備であり、必要になったタイミングで整備する。

## MCP 接続確認 (一度だけでよい)

`claude mcp list` で `chrome-devtools` が登録されていることを確認する。未登録なら次のコマンドで登録する (ランチャーが起動している間のみ接続確認できる):

```
claude mcp add --scope local chrome-devtools -- npx chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9222
```

### 登録済みでも MCP ツールを呼び出せない場合

「`claude mcp list` で Connected」と「自分のツール一覧に `mcp__chrome-devtools__*` がある」は別レイヤーの確認である。次の場合、登録済みでもツールは呼び出せない。

- subagent として実行されている (MCP ツールは subagent に継承されない)
- 登録した直後のセッション (反映はセッション再起動後)

ツールが無い場合は自動化の代替に走らず、生 CDP (`curl http://127.0.0.1:<port>/json/version`, `/json/list`) での起動・拡張ロード確認までに留め、ページ操作が必要ならその旨を報告して main セッション側に委ねる。

### ポートを変更する場合

- 代替ポートは `ss -ltn` で空きを確認してから 9223, 9224, … の順に採番する
- 一時的なポート変更では MCP 登録 (`--browser-url`) は書き換えず、確認は生 CDP で行う。登録を書き換えた場合は、作業後に必ず 9222 に戻す (`claude mcp remove chrome-devtools` → 上記 add コマンド)

## 安全上の注意

- profile (`~/.local/share/fanbox-downloader-extension/live-profile`) には実セッションの Cookie が入る。リポジトリに含めない・他人と共有しない
- 実 FANBOX の API を叩く。大量ダウンロードの実行はユーザの明示的な依頼があるときのみ行う
- 収集対象は最小限 (1〜2 投稿) に絞る
- レート制限を尊重し、連続実行しない
