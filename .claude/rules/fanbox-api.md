---
paths:
  - 'src/content/fanbox/collector.ts'
  - 'src/content/fanbox/api.ts'
---

# FANBOX API の落とし穴

- 配列レスポンスは `body` 直下ではなく `body.<キー>` に入る。形状が想定と違うときに空配列へ落とすと「本当に 0 件」と区別が付かず、中身のない ZIP を完了として出してしまうので `ApiShapeError` で中断する
- `post.listCreator` の一覧レスポンスには本文が含まれないため、各投稿は `post.info` への追加リクエストを経て収集される
  - 一覧の時点で結果が決まる投稿 (`isRestricted`、「無料を省く」指定に該当する `feeRequired === 0`) は `post.info` を発行せずに飛ばす。発行しても弾かれるだけで、レート制限の枠と待機時間を消費する
  - この判断に使う `id` / `isRestricted` / `feeRequired` は一覧要素の validator で検証する。欠けたまま続けると、利用者が指定した除外が無言で効かなくなる
- ZIP のルートに `download-manifest.json` が入る。review 画面で確定した `Selection` を `project()` に渡した結果がそのまま記録される

## 失敗の扱いはエラー型で決まる

投稿単位・ページ単位の失敗として数えて続行してよいのは `HttpError` (2xx 以外の応答) だけ。それ以外を握りつぶすと、実装上のバグまで通信障害として数えたまま収集が続く。

- **再試行枠の枯渇は収集全体を止める。** 上限まで待った直後に別のエンドポイントへ要求を出すのは、再試行上限を実質的に延長することになるため、プラン名・タグの取得中でも握りつぶさない。取り込めた投稿があれば `stoppedReason` を付けて部分保存し、1 件も無ければ例外として扱う
- **安全に取り込めない仕様変更は中断する。** 判定は `overlay.ts` の `isUnsupportedResponseError` が SoT
- 例外は `plan.listCreator` と `tag.getFeatured` の 2 つだけ。形状の不一致も HTTP エラーも握りつぶして続行する (表示の補助しか担っておらず、ZIP の中身は欠けないため)。枯渇だけは再送出する
- 取得できなかった投稿は失敗件数として報告する。投稿一覧ページの失敗は欠落した投稿数が不明なので、投稿単位の件数とは分けて数える

## 検証境界 (ValerianDillon/download-helper#30)

検証境界は共有層の `addByPostInfo` の入口にある。拡張側の `fetchApi` 系が保証するのは収集の分岐に使うフィールドだけで、返す型は「検証済み」を名乗らない (`PostInfoCandidate` / `PostListItemCandidate`)。

本文の検証は `addByPostInfo` が行い、収集が実際に読むフィールドだけを厳密に確かめる。情報 JSON に写すだけの付随メタデータは型を検証しない (`invalid` は収集全体の中断を意味するため、読まないフィールドの型変化で全件止めない)。

アセットの `id` は必須 (ValerianDillon/download-helper#41)。無いと `invalid` になり収集が止まる。
