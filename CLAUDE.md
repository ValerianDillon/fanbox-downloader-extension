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

## 収集後の対象選択 (Issue #55)

収集が終わると `review` 状態で止まり、投稿 × 添付の拡張子 × カバー画像を選ばせる。
絞り込みの意味論と導出は共有層が持つ (`Selection` / `DownloadObject.project()`)。
拡張が担うのは選択 UI と状態遷移だけで、**生成済みの HTML を解析して直すことはしない**。

- **選択の SoT は `Set<postId>` であって DOM のチェック状態ではない** (`src/content/review-model.ts`)。検索や再描画でチェックボックスの要素は入れ替わるので、DOM を SoT にすると絞り込みの操作だけで選択が変わる
- 投稿リストには描画上限 (`POST_LIST_RENDER_LIMIT`) を設ける。選択は postId の集合に適用するので、**描画されていない投稿も一括操作の対象になる**
- 一括操作は 全選択 / 全解除 / 検索結果の選択 / 検索結果の解除 の 4 つ。「表示中」を対象にする操作は入れない (検索一致が描画上限を超えたとき、利用者がどちらを指すのか判別できない)。反転も入れない
- サイズの合計は断定しない。`size` は file 系のアセットにしか無く image 系とカバーには無いため、既知分と不明な件数を分けて出す。**サイズを得るための HEAD リクエストは追加しない** (Issue #51 が未解決の状態でメディアホストへの要求を増やす利益が無い)

### AbortController の分離と実行世代

収集用と ZIP 用で分ける。
選択の確定を待つ区間を 1 つの controller で覆うと、「キャンセル」の意味が段階ごとに変わる。
収集用は `collect()` が返った時点で役目を終え、ZIP 用は確定時に新しく作る。

**旧実行が新実行の画面と観測状態を書き換えないよう、状態に触る前に必ず現行かを判定する。**
中断してすぐ再実行すると、旧実行の非同期処理が遅れて解決する。

- `await` の直後の最初の判定を `isCurrentCollect` / `isCurrentDownload` にする。エラー表示も publish もその後に置く
- `downloadZip` に渡す進捗コールバックは `await` の後の判定では間に合わないので、呼び出しごとに判定する
- ZIP の書き込みは中断されても最後まで走るため、パネルを閉じて別の収集を始めた後に旧実行の `close()` が完了しうる。確定時に採番する `downloadRunId` で判定する (`AbortController` は確定の後に作られるので、確定時に確保する保存先ハンドルからは参照できない)

### 状態遷移表の置き場所

遷移表 (`OVERLAY_TRANSITIONS`) は `overlay.ts` にあり、そこが SoT である。
テスト側に手で持つと、実装が表に無い遷移をするようになってもテストは通ってしまう。

- テストビルドの `setState` が表に照らして検証する。表を狭めると e2e が落ちる
- ユニットテストは表の中身そのものを固定する。表を広げるとこちらが落ちる
- 通常ビルドでは検証しない。遷移表の破れは開発時の誤りであって、利用者の画面を落として直すものではない

### showSaveFilePicker の位置

**review の確定ボタンのクリックで呼ぶ。**
以前は「ダウンロード開始」のクリック時に呼んでいた。収集が長引くと transient activation が失効するため、収集より前に保存先を確保する必要があったからである。
確定ボタンのクリック自体が新しいユーザアクティベーションになるので、review 画面での操作が何分続いても保存先を確保できる。

- **確定ハンドラでは picker より先に await も重い処理も置かない。** 絞り込み済みの対象の導出 (`project`) と検証 (`assertDownloadable`) は、選択が変わってから `PROJECTION_DEBOUNCE_MS` の静穏時間を置いて先に済ませておく (`prepareProjection`)
- **`showSaveFilePicker` は解決した時点で対象ファイルの中身を空にする。** 新規なら 0 バイトで作成し、既存ファイルを選べばその内容を消す (File System Access 仕様 3.4)。導出や検証で落ちる可能性を picker より前に潰さないと、書くものが無いまま利用者のファイルだけが空になる
- 検証は共有層の `preflight` を呼ぶ。`isDownloadJsonObj` だけでは足りない — `downloadZip` は型検証の後にも投稿ディレクトリ名の重複や予約名との衝突を見ており、そちらは型検証を通る入力でも落ちうる (legacy allocator は投稿名が `a` / `a` / `a_1` のとき `a_1` を 2 回割り当てる。ValerianDillon/download-helper#52)
- 投稿が 0 件選択のときは確定ボタンを無効にする (picker を出さない)
- `AbortError` (選択の取りやめ) はエラー画面にせず、選択状態を保ったまま review に留まる。それ以外の失敗は review 内のエラーとして表示する
- 収集の結果 `addedPostCount === 0` だった場合と、未対応のレスポンス形式で中断した場合は review へ進まないので、保存先も確保しない。**Issue #14 の「0 バイトの ZIP が残る」経路はこれで無くなった** (picker 成功後・`createWritable()` の前に例外が起きれば新規ファイルは残りうるので、完全に無くなったわけではない)

`beforeunload` は収集の開始から完了画面まで維持する。
review 画面で収集結果を失うのも実害は同じで、選択に時間をかけている間ほど失うものが大きい。

## archive path の採番 (Issue #56)

`src/content/archive-path.ts` の allocator を共有層に差し替える。
従来の採番 (`createLegacyArchivePathAllocator`) は同名グループの件数に依存するため、**同名の投稿やアセットが増減すると過去に割り当てた名前まで変わる**。
複数の ZIP をまたいで同じ投稿を同定できないので、差分ダウンロードの保存実績が指す先を失う。

- 投稿ディレクトリ: `<postId>_<タイトル>`。タイトルが空に潰れる場合は `<postId>` だけ
- 本文アセット: `<元の名前>_<kind>_<assetId><拡張子>`。**鍵は常に付ける** — 衝突したときだけ付ける形にすると、同名のアセットが増えた時点で既存の名前が変わる
- カバー: `cover<拡張子>`。投稿に高々 1 つなので、それだけで一意である

**`kind` も名前に入れる。** 共有層の identity は `kind` と `assetId` の組で、image と file で同じ `assetId` が来ても別のアセットである。
`assetId` だけだと同じ名前になり、同じパスに 2 エントリ入って片方が失われる (共有層はアセット同士の名前衝突を検査しない)。
副産物として、アセット名には必ず `image_` / `file_` が入るので投稿ディレクトリ直下の予約名 (`index.html` / `info.json` / `info.txt`) と一致しない。

**識別子 (postId / assetId / 拡張子) は `~` を escape 記号にして符号化する。**
元の名前は利用者が付けた任意の文字列で `_file_` のような並びを含みうるので、識別子側にもそれが現れると別の組が同じ archive 名になる。
拡張子も共有層の decoder が文字列としてしか検証していないので同じ扱いにする。
`encodeFileName` が別の文字へ潰す文字 (`/` と `／` など) も符号化するので、正規化で潰れて同じ名前になることも無い。
`-` を残すのは FANBOX の ID に現れる文字で、残しても曖昧さが生じないため。

**組み立てだけに頼らず、割り当て終えた名前の一意性を検査して重なれば例外にする。**
比較は Unicode を NFC へ寄せ、大文字小文字を畳み、末尾の空白とピリオドを落としてから行う。
Windows と既定の macOS は大文字小文字を区別せず、Windows は末尾の空白とピリオドを取り除き、macOS の APFS は正規化を区別しない。
完全一致だけで比べると、展開時に一方が上書きされる名前を通してしまう。

**孤立サロゲートは U+FFFD へ潰してから扱う。** ZIP のエントリ名は `TextEncoder` で UTF-8 にするが、孤立サロゲートはそこで置き換えられる。
潰す前で一意性を見ると、書き込み時に同じバイト列になる名前を別物として通してしまう。
文字列の形だけで単射を保証しきるのは難しく (`encodeFileName` の潰し、凍結名は任意の値を取れる)、共有層はアセット同士の名前衝突を検査しない。
検出しないと同じパスに 2 エントリ入って片方が黙って失われる。
例外にすれば、`prepareProjection` が保存先を確保する前に気付ける。

**同じ投稿が一覧に 2 回来たら 1 回しか取り込まない** (`collector.ts` の `seenPostIds`)。
ただし取得に失敗した投稿は「結果が出た」に含めない。重複側で取り直せる可能性を残す。
失敗は件数ではなく postId の集合 (`apiFailedPostIds`) で数える — 件数で数えると 1 つの投稿が 2 件の失敗になり、取り直せたときに取り消せない。
archive path が postId 由来なので、2 回登録すると投稿ディレクトリ名が重複し、共有層の `preflight` が ZIP 全体を拒否する。
従来の採番は同名グループとして採番し直していたので保存できていた。
併せて `post.info` の発行も 1 回で済む。

**`%` と `?` は全角へ寄せる。** どちらも `encodeFileName` が写さない。
`%` は共有層の HTML 生成が使う `encodeURI` も符号化しないので、`%2F資料` は ZIP ではそのままなのに HTML の参照が `/資料` として解釈され、実在しないファイルを指す。
`?` は Windows でファイル名に使えない。
共有層は「直すと出力が変わる」既知の欠陥として残しているが、こちらは出力形式を変えたうえでその名前を保存実績として固定するので、固定する前に直す。
凍結名にこれらが含まれていれば受け取った時点で拒否する。

名前は**セグメント全体の UTF-8 バイト数**で切る (`SEGMENT_MAX_BYTES`)。
ext4 のファイル名上限は 255 bytes で、超えると ZIP は作れても展開できない。
コードポイント数で切ると、絵文字のように 1 文字が 4 bytes の名前で上限を超える。
識別子と拡張子を先に確保し、残りを元の名前に割り当てる。
コードポイント単位で足していくのは、UTF-16 の符号単位で切るとサロゲート対が割れるため。
`encodeFileName` の後に末尾の空白とピリオドを落とすのは、Windows がそれらを取り除いて解釈するため (残すと共有層の予約名判定と食い違う)。

`FrozenArchiveNames` を渡すと、そこに載っている投稿・アセットはその名前をそのまま使う。
受け取った Map は複製し、名前がパスセグメントとして使えるか (空・`.`・`..`・区切り文字・制御文字・正規化済み) と**同じ投稿の中で一意か**を作成時に確かめる。
予約名との衝突はここでは見ない — どのファイル名が予約されているかは共有層が決めることで、こちらに写すと定義が 2 箇所になる。
複製しないと作成後の変更で同じ入力への結果が変わり、共有層が求める決定性を破る。
凍結名は保存実績とずれるので後から直せないため、不正なら受け取った時点で拒否する。
アセットは postId で入れ子にする — 区切り文字で連結した平坦なキーにすると、その文字が postId や assetId に現れたときに別の組が同じキーへ潰れる (その不変条件はどこも検証していない)。
**一度出力した名前は、投稿タイトルやアセット名が編集されても変えない。**
変えると過去の ZIP と同じ投稿を同定できなくなる。

`ARCHIVE_FORMAT_VERSION` で出力形式を明示的に分ける。
採番規則が変わったことを記録しておかないと、実際には別の場所に入っている過去の ZIP を根拠に取得を省いてしまう。

## メディア取得の分割転送 (Issue #22)

単発の `sendMessage` の応答に本文全体を base64 で載せる方式は、runtime messaging の 64 MiB 上限に base64 の 4/3 膨張込みで当たり、**約 48 MiB 以上のファイルが必ず失敗していた**。

content script が Port を張り、service worker が本文を `CHUNK_BYTES` (8 MiB) ごとに chunk へ分けて流す。ワイヤ契約は `src/media-stream-protocol.ts` に集約し、両バンドルで共有する。

- **MV3 の service worker はいつでも停止しうる** (30 秒無活動 / 5 分上限 / fetch 応答 30 秒)。転送途中で Port が切れたら、受信済みバイト数を offset にした `Range` 要求で新しい Port を張って再開する。切断が続けば `MAX_RESUMES` 回で諦めて上位の再試行に委ねる
- 低速回線で `CHUNK_BYTES` が 30 秒以内に溜まらないと転送中に停止するため、chunk が満たなくても `FLUSH_INTERVAL_MS` ごとに送って idle timer をリセットする (Chrome 114 以降、Port はメッセージ送受信でもリセットされる)
- **本文全体を JS ヒープに保持しない。** 受信合計を `Content-Length` と終端メッセージのバイト数に突き合わせ、一致しなければ成功にしない (欠けたファイルを ZIP に入れないため)
- API 取得 (`fetchApi`) は単発の `sendMessage` のまま。JSON はサイズ上限に達しない

再開の分岐と、実サイトで Range 再開が効かない理由は `src/content/media-stream.ts` の JSDoc が SoT。

## API のレート制御 (ValerianDillon/fanbox-downloader#3)

ゲート・再試行・適応スロットル・直列化・エラー型は共有層の `ApiSession` が持つ。拡張側 (`src/content/fanbox/api.ts`) は `Transport` の実装と、FANBOX 固有の URL 組み立て・レスポンス検証だけを持つ。ブックマークレット版と同じ契約・同じテストを通すため。

- transport は 3 系統を返す。`response` (status を観測できた) / `unobservable-failure` (応答を得られなかった) / `deferred` (I/O を発行しなかった)。**observable な 429 と「429 かもしれない失敗」を型で分け、後者から status を推測しない**
- service worker が既知のバックオフ期限中で fetch を発行しなかった応答は `deferred` へ変換する。adapter の内側で待って再要求すると、セッションが実際の発行時刻を見失って基準間隔と適応間隔が抜けるため、**待機と再発行はセッションが行う**
- 再試行ポリシーはセッション側にある。詳細は共有層の JSDoc が SoT

### 状態のスコープ

2 つに分かれる。

- **収集ごと** — 基準間隔・適応間隔・再試行回数・連続成功数 (`ApiSession` を収集ごとに作る)
- **service worker (`chrome.storage.session`)** — サーバー指定のバックオフ期限。タブと収集をまたぐ (Issue #16)

`api.ts` の `sharedBackoffUntil` は後者の参照値で、更新は `fetchApi` の応答からのみ行う。**発行の前に問い合わせて取り込むことはしない** — 往復のぶん実際の発行が遅れ、往復の所要時間が要求ごとに違うと実発行間隔が基準間隔を下回る。期限の最終判定は service worker 側のゲートが持ち、そこで弾かれた応答が最新の期限を運んでくる。

`Retry-After` の解釈は共有層の `parseRetryAfterMs` に一本化する。期限を記録する service worker と待機時間を決めるセッションで解釈が違うと、セッションが「読めないので固定バックオフ」と判断した値を service worker が期限として記録し、タブと収集をまたいで長すぎる待機になる。

### 発行時刻の扱い (Issue #46)

service worker が実際に `fetch` を開始した時刻を応答に載せ、セッションがそれを記録する。セッションが自前で記録するのは `sendMessage` の直前なので、service worker の起動待ちで配送が遅れると記録と実発行がずれ、次のゲートがその遅延ぶん早く明ける。

報告値は別プロセス由来なので、実際の発行が起きうる区間 (`transport` 呼び出しの直前〜応答が返った時刻) に収まっていればそのまま採る。

外れた値は**区間の上端に倒す**。区間内のどこで発行されたか分からない以上、真の発行時刻以降と確実に言えるのは上端だけで、下端に倒すと配送が遅れていた場合に次の発行が早まる。報告そのものが無いとき (旧 service worker、同一プロセスで発行するブックマークレット版) だけ下端を使う。

送信後にキャンセルすると応答が transport に届かないため、実発行時刻は記録されない。キャンセル直後の再収集が進行中の `fetch` と間隔を空けない件は Issue #49。

## ZIP フェーズのメディア取得 (Issue #51)

**429 の制御が無く、観測だけを持つ。** `fetchWithRetry` は失敗のたびに 1 秒待って再試行するだけで (1 対象につき最大 2 回)、429 と 404 / 500 を区別せず `Retry-After` も待機に使わない。収集フェーズのバックオフとも無関係で、取得先ホストも異なる。

制御方式を決める前に観測が要るため、試行記録を `chrome.storage.local` の `fbdlMediaAttempts` に蓄積する (`src/content/media-attempt-log.ts`)。URL も投稿名も含めず、どこにも送信しない。上限 2000 件。

保存は `downloadAsZip` の `finally` で行う。**観測したい 429 は失敗した実行にこそ現れる**ので、成功時だけ保存すると最も見たい事象が落ちる。

読み出し・集計・削除の手順は `.claude/skills/extension-live-test/SKILL.md` が SoT。

## FANBOX API の落とし穴

- 配列レスポンスは `body` 直下ではなく `body.<キー>` に入る。形状が想定と違うときに空配列へ落とすと「本当に 0 件」と区別が付かず、中身のない ZIP を完了として出してしまうので `ApiShapeError` で中断する
- `post.listCreator` の一覧レスポンスには本文が含まれないため、各投稿は `post.info` への追加リクエストを経て収集される
  - 一覧の時点で結果が決まる投稿 (`isRestricted`、「無料を省く」指定に該当する `feeRequired === 0`) は `post.info` を発行せずに飛ばす。発行しても弾かれるだけで、レート制限の枠と待機時間を消費する
  - この判断に使う `id` / `isRestricted` / `feeRequired` は一覧要素の validator で検証する。欠けたまま続けると、利用者が指定した除外が無言で効かなくなる
- ZIP のルートに `download-manifest.json` が入る。review 画面で確定した `Selection` を `project()` に渡した結果がそのまま記録される

### 失敗の扱いはエラー型で決まる

投稿単位・ページ単位の失敗として数えて続行してよいのは `HttpError` (2xx 以外の応答) だけ。それ以外を握りつぶすと、実装上のバグまで通信障害として数えたまま収集が続く。

- **再試行枠の枯渇は収集全体を止める。** 上限まで待った直後に別のエンドポイントへ要求を出すのは、再試行上限を実質的に延長することになるため、プラン名・タグの取得中でも握りつぶさない。取り込めた投稿があれば `stoppedReason` を付けて部分保存し、1 件も無ければ例外として扱う
- **安全に取り込めない仕様変更は中断する。** 判定は `overlay.ts` の `isUnsupportedResponseError` が SoT
- 例外は `plan.listCreator` と `tag.getFeatured` の 2 つだけ。形状の不一致も HTTP エラーも握りつぶして続行する (表示の補助しか担っておらず、ZIP の中身は欠けないため)。枯渇だけは再送出する
- 取得できなかった投稿は失敗件数として報告する。投稿一覧ページの失敗は欠落した投稿数が不明なので、投稿単位の件数とは分けて数える

### 検証境界 (ValerianDillon/download-helper#30)

検証境界は共有層の `addByPostInfo` の入口にある。拡張側の `fetchApi` 系が保証するのは収集の分岐に使うフィールドだけで、返す型は「検証済み」を名乗らない (`PostInfoCandidate` / `PostListItemCandidate`)。

本文の検証は `addByPostInfo` が行い、収集が実際に読むフィールドだけを厳密に確かめる。情報 JSON に写すだけの付随メタデータは型を検証しない (`invalid` は収集全体の中断を意味するため、読まないフィールドの型変化で全件止めない)。

アセットの `id` は必須検証になった (ValerianDillon/download-helper#41)。無いと `invalid` になり収集が止まる。

## テスト

- **テストビルド専用コードは通常ビルドに残さない。** content script は ISOLATED world で動き、Playwright (MAIN world) から状態を直接読めない。そのためテストビルドのみ `data-fbdl-*` 属性や `globalThis.__fbdlTestState` で状態を publish する
  - `--define` + dead code elimination で消え、post-build 検証が通常ビルドの成果物を fail-closed で確認する
- smoke test の責務は「FAB クリック → 収集 → ファイル取得 → ZIP 生成の完走」まで
- 分割転送 (Issue #22) は `e2e/large-media.spec.ts` が 48 MiB / 64 MiB 超のファイルを SHA-256 で照合する。50 MiB 級の fixture はリポジトリに置かずテスト実行時に生成する
- 実ファイル保存と mtime 検証は smoke test の対象外 (`showSaveFilePicker` はネイティブダイアログを要求し自動化できない)。`publishedDatetime` の mtime 反映は `test/downloader.test.ts` でカバー

### WSL2 headless の癖

- 拡張を読み込むには Playwright に `channel: 'chromium'` が要る (新しい headless 実装でのみ拡張読み込みに対応)
- WSLg の `DISPLAY` / `WAYLAND_DISPLAY` を引き継いだまま起動すると、最初の `requestAnimationFrame` の配送が 60〜100 秒止まり Playwright の stable 判定が固まる。`e2e/harness.ts` の `browserEnv()` でこの 2 つを取り除いて起動する

## 実機テスト (実 FANBOX)

ランチャーは `scripts/live-browser.ts`。起動方法・手順・診断・安全上の注意は `.claude/skills/extension-live-test/SKILL.md` が SoT。

## コーディング規約

Biome (recommended ルールセット) で強制。設定は `biome.json` が SoT。

## Git 運用

マージは squash。`main` の履歴は `<タイトル> (#42)` の形の単一コミットで揃える。
