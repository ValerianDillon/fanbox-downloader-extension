---
paths:
  - 'src/media-stream-protocol.ts'
  - 'src/content/media-stream.ts'
  - 'src/service-worker/media-stream.ts'
---

# メディア取得の分割転送 (Issue #22)

単発の `sendMessage` の応答に本文全体を base64 で載せる方式は、runtime messaging の 64 MiB 上限に base64 の 4/3 膨張込みで当たり、**約 48 MiB 以上のファイルが必ず失敗していた**。

content script が Port を張り、service worker が本文を `CHUNK_BYTES` (8 MiB) ごとに chunk へ分けて流す。ワイヤ契約は `src/media-stream-protocol.ts` に集約し、両バンドルで共有する。

- **MV3 の service worker はいつでも停止しうる** (30 秒無活動 / 5 分上限 / fetch 応答 30 秒)。転送途中で Port が切れたら、受信済みバイト数を offset にした `Range` 要求で新しい Port を張って再開する。切断が続けば `MAX_RESUMES` 回で諦めて上位の再試行に委ねる
- 低速回線で `CHUNK_BYTES` が 30 秒以内に溜まらないと転送中に停止するため、chunk が満たなくても `FLUSH_INTERVAL_MS` ごとに送って idle timer をリセットする (Chrome 114 以降、Port はメッセージ送受信でもリセットされる)
- **本文全体を JS ヒープに保持しない。** 受信合計を `Content-Length` と終端メッセージのバイト数に突き合わせ、一致しなければ成功にしない (欠けたファイルを ZIP に入れないため)
- API 取得 (`fetchApi`) は単発の `sendMessage` のまま。JSON はサイズ上限に達しない

再開の分岐と、実サイトで Range 再開が効かない理由は `src/content/media-stream.ts` の JSDoc が SoT。
