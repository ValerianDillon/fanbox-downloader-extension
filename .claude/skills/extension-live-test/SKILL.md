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
2. 拡張の FAB ボタン (画面右下 `bottom: 24px; right: 24px` に固定表示、`src/content/fab.ts`) をクリックする。通常ビルドの shadow root は closed のため DOM セレクタでは shadow 内に届かない。closed shadow root でも accessibility tree には露出するため、`take_snapshot` を撮ると FAB は `button "⬇" description="FANBOX Downloader"` として uid 付きで現れる。この uid をクリックするのが最も安定する (スクリーンショットからの座標クリックでもよい)
3. overlay パネルで収集対象を最小限に設定して実行し、進行は overlay の表示で確認する
   - 「取得件数上限」は「`addByPostInfo` が `'added'` を返した投稿の件数」の上限であり、試行回数の上限ではない (`DownloadManage.decrementLimit` は登録成功時のみ減算する)。支援していないクリエイターでは投稿がほぼ登録できず上限に到達しないため、上限 1 に設定しても全投稿分の `post.info` を発行する。実 API への負荷を最小化したいなら、自分が支援していて数投稿だけ登録できるクリエイターを選ぶか、投稿数の少ないクリエイターを選ぶ
4. 保存ステップ (`pickSaveHandle` → `showSaveFilePicker`, `src/content/downloader.ts`) はネイティブのファイル保存ダイアログを要求するため、headless では完走できない。実測では headless Chromium の `showSaveFilePicker` は即座に `AbortError` を投げる。かつこのハンドル取得は収集より前 (ダウンロード開始直後のユーザジェスチャー中) に呼ばれるため、通常ビルドの headless では収集自体が始まらずオーバーレイが settings のまま留まる。保存まで確認したい場合は headed で行う

### headless で収集フローを観測したい場合はテストビルドを使う

通常ビルドの headless では上記のとおり picker が収集前に abort するため、実 API を相手にした収集・メディア取得・完了画面の分岐を観測できない。これらを headless で観測したいときはテストビルド (`__FBDL_TEST__=true`) を一時的に `dist/` へ置く。

- テストビルドは (a) shadow root を `open` にする (b) `showSaveFilePicker` をインメモリ stub に差し替える (c) `document.documentElement` に `data-fbdl-*` 属性で状態を publish する。ネットワークは stub されないため実 FANBOX API を叩く点は通常ビルドと同じ
- 手順: `bun run build:test` → `dist/` を退避して `dist-test/` の内容を `dist/` にコピー → ランチャー起動。観測後は `rm -rf dist && bun run build` で通常ビルドを再生成して必ず戻す (`dist/` は git 管理外なので commit には影響しないが、次回の通常テストのために戻す)
- open shadow root なので `document.getElementById('fanbox-downloader-ext-fab').shadowRoot` / `...-overlay').shadowRoot` から DOM を直接操作・観測できる。最終結果は `data-fbdl-overlay-state` / `data-fbdl-added-post-count` / `data-fbdl-unavailable-post-count` / `data-fbdl-unsupported-post-count` / `data-fbdl-api-failed-post-count` / `data-fbdl-failed-page-count` / `data-fbdl-zip-done` などで読める (`data-fbdl-zip-done` が付かなければ ZIP は保存されていない)

## 診断 (CDP が応答しない・操作できない場合)

- ランチャーが `dist/ が見つかりません` と出力して終了した → `bun run build` を先に実行する (自動ビルドはしない設計)
- `--remote-debugging-port` のポートが既に使用中 (bind エラー) → 前回のランチャーが残っていないか `pgrep -af live-browser.ts` で確認し、残っていれば SIGTERM で止める。無関係なプロセスが占有している場合は勝手に kill せず、「ポートを変更する場合」(下記 MCP 接続確認の節) に従って別ポートで起動する
- 同じ `--profile` を指す別プロセスが起動している → Chrome の profile ロックにより起動に失敗することがある。`pgrep -af live-browser.ts` で他のプロセスが同じ profile を使っていないか確認してから再起動する
- メディア取得だけが全件 `status 0` で失敗し、ページ console に `Unchecked runtime.lastError: Could not establish connection. Receiving end does not exist.` が並ぶ → 旧版の service worker がキャッシュされて起きる症状。ランチャーが起動時に `Default/Service Worker` を自動削除するため通常は起きない。`--keep-sw-cache` を付けた場合のみ発生し得るので、その場合は手動で削除して再起動する。確認は `bun scripts/live-cdp-eval.ts sw 'chrome.runtime.onConnect.hasListeners()'` (新版なら `true`)
- CDP (`/json/version`) には応答するが拡張が見当たらない → `curl -s http://127.0.0.1:<port>/json/list` を見て `"type": "service_worker"` のエントリ (`chrome-extension://.../service-worker.js`) があるか確認する。無ければ拡張の読み込み自体に失敗しているので `dist/` の中身 (`manifest.json` の有無など) を確認する

## ログイン bootstrap (初回 / セッションが切れている場合)

FANBOX のログインには CAPTCHA があるため自動化しない。ユーザに手動ログインを依頼する。

1. `bun scripts/live-browser.ts --headed` で起動する (`--profile` を明示的に指定しない限り、通常の headless 実行と同じデフォルトプロファイルを使う。これにより保存された Cookie が headless 実行時にも引き継がれる)
2. WSLg 上にウィンドウが表示されるので、ユーザに手動でログインしてもらうよう依頼する
3. ログイン完了を確認したら Ctrl+C (SIGINT) でランチャーを終了する (セッション Cookie がプロファイルに保存される)
4. 以降は通常どおり `--headed` なし (headless) で起動して使う

### agent のシェルから headed 起動に失敗する場合

agent の実行シェルから headed 起動できる場合もある (`XAUTHORITY` 未設定でも `timeout 5 xset q` が応答すれば起動できた実績がある)。まず 1 回試すこと。

一方、agent の実行シェルには WSLg の X 認証が引き継がれないことがあり、`DISPLAY` が設定されていても `Missing X server or $DISPLAY` で headed 起動に失敗する (`XAUTHORITY` 未設定、または WSLg の X サーバ自体が無応答)。この失敗は環境要因であり、スクリプトや拡張の不具合ではない。

- 同じ起動を繰り返さない。1 回失敗したら切り分け (`timeout 5 xset q` の応答有無) をして止める
- ユーザに、**agent のシェルではなくユーザ自身のターミナル**で `bun scripts/live-browser.ts --headed` を実行して手順 2〜3 (ログイン → Ctrl+C) を行うよう依頼する。プロファイルは同じ場所を使うため、完了後は agent 側から headless で Cookie を利用できる
- ユーザのターミナルでもウィンドウが出ない場合は WSLg 自体の不調の可能性がある (`wsl --shutdown` からの再起動をユーザに提案する。agent のセッションも道連れになるため、実行前に作業を push しておく)

## headless はボット判定で偽の失敗を出す (headed との使い分け)

headless Chromium は UA が `HeadlessChrome/...` になり、Cloudflare のボット判定を受ける。実測では、同じアカウント・同じ拡張で次の差が出た。

| | headless | headed |
| --- | --- | --- |
| UA | `HeadlessChrome/149.0.0.0` | `Chrome/149.0.0.0` |
| 収集 216 件中の `post.info` 失敗 | 34 件 | 0 件 |
| 収集 73 件中の `post.info` 失敗 (別クリエイター、2026-08-16) | 65 件 | 0 件 |

つまり **headless で観測した「API 通信に失敗した投稿」は拡張の不具合ではなくボット判定である可能性が高い**。失敗率や通信エラーを評価したいときは headed で確認する。UI の遷移や状態管理の確認だけなら headless で足りる。

## 実 API のレスポンス形状を観測する (service worker 経由)

`api.fanbox.cc/post.info` はページ origin (`www.fanbox.cc` / `<creatorId>.fanbox.cc`) からでも読める。同期 XHR・`fetch` とも 200 を返す。`post.listCreator` や `plan.listSupporting` も同様に読める。

生のレスポンス形状を観測したいときは、host_permissions を持つ拡張の service worker コンテキストで evaluate する。`playwright.connectOverCDP` は chrome-devtools MCP が同じ endpoint を掴んでいると接続がタイムアウトすることがあるため、`bun scripts/live-cdp-eval.ts sw '<expression>'` を使う (service worker ターゲットの webSocketDebuggerUrl に直接 WebSocket で接続し `Runtime.evaluate` を送る CLI)。

例: `bun scripts/live-cdp-eval.ts sw "(async()=>{ const res = await fetch('...'); return await res.json(); })()"`

ページ origin からの見え方を確認したいときは `page` ターゲットを使う: `bun scripts/live-cdp-eval.ts page '<expression>'`。第 1 引数が対象ターゲットで、`page` は `type === 'page'` の先頭、`sw` は service worker を選ぶ。

## メディア取得の試行記録を読む (Issue #51 の観測)

ZIP フェーズの取得試行は `chrome.storage.local` の `fbdlMediaAttempts` に蓄積される (ホスト / ステータス / `Retry-After` / 種別 / 時刻、上限 2000 件)。
実機実行の後に取り出して、`downloads.fanbox.cc` や `*.pximg.net` で 429 が出ているかを見る。

```
bun scripts/live-cdp-eval.ts sw "chrome.storage.local.get('fbdlMediaAttempts')"
```

集計だけしたいときは service worker 側で絞ってから返す。

```
bun scripts/live-cdp-eval.ts sw "(async()=>{const r=await chrome.storage.local.get('fbdlMediaAttempts');const a=r.fbdlMediaAttempts??[];return {total:a.length, byStatus:a.reduce((m,x)=>(m[x.status]=(m[x.status]??0)+1,m),{}), hosts:[...new Set(a.map(x=>x.host))]};})()"
```

記録を消すときは `chrome.storage.local.remove('fbdlMediaAttempts')`。

日常利用のブラウザ (実機テスト用プロファイルではない方) で貯めた記録を見る場合は、`chrome://extensions` の拡張の「Service Worker」から devtools を開き、同じ式をコンソールで実行する。

## 実機では再現できない経路 (バックオフ待機)

service worker のバックオフ期限は `BackoffStore` のメモリキャッシュ越しに読まれ、キャッシュが未設定のときだけ `chrome.storage.session` を読む (`src/service-worker/backoff-store.ts` の `getLocked`)。
一度でも `fetchApi` を処理した service worker はキャッシュを持つため、**外から `chrome.storage.session` に期限を書いても反映されない**。
書き込み自体は成功し、収集も待機せず完走するので、「バックオフが効いていない」という誤った観測に見える。

回避策も無い。`chrome.runtime.reload()` で service worker を作り直すと、開いているタブへ content script が再注入されず FAB が出なくなる (ページをリロードしても戻らない)。
キャッシュに載せる経路は実際に 429 を受けることだけで、それは実サービスへの濫用にあたるので行わない。

したがって `deferred` (期限中は発行しない) の検証は実機テストの対象外とし、`test/rate-limit-lifecycle.test.ts` が実物の `handleFetchApi` / `BackoffStore` を fake storage 越しに通して担う。

## 生成した ZIP を実データで検証する

テストビルドは `showSaveFilePicker` を stub し、生成した ZIP を base64 で `data-fbdl-zip-b64` に publish する。実データの ZIP を検証したいときはこれを取り出す。

- ZIP に投稿が入るには `addByPostInfo` が登録できる必要があるため **headed で行う**。headless はボット判定で `post.info` がほぼ全件失敗し (実測 2026-08-16: 73 件中 65 件失敗、登録 0 件)、ZIP が生成されない

- `data-fbdl-zip-b64` が publish されるのは ZIP が `ZIP_B64_PUBLISH_LIMIT` (8 MiB、`src/content/test-hooks.ts`) 以下のときだけで、超えると `zip-url` (Blob URL) と `zip-size` のみになる。取り出しは ZIP サイズによらず `bun scripts/live-pull-zip.ts <out.zip>` を使う (8 MiB 以下で zip-b64 を使う場合も MCP `evaluate_script` の戻り値でインラインに受け取らず `filePath` で保存する)
- 保存後は `unzip -l` (ディレクトリエントリと日時) / `unzip -t` (整合性) / 展開して `date -r` (展開後の mtime) で検証できる

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
