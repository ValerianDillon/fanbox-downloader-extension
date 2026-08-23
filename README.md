# fanbox-downloader-extension

pixiv FANBOX の投稿を ZIP として一括ダウンロードする Chrome 拡張 (Manifest V3)。

[fanbox-downloader](https://github.com/ValerianDillon/fanbox-downloader) のブックマークレット版を Chrome 拡張に移行したもの。
`host_permissions` による CORS 回避により、1 クリックでデータ収集からZIPダウンロードまで完結する。

## インストール

Chrome Web Store には未公開。ローカルからサイドロードする。

```bash
git clone https://github.com/ValerianDillon/fanbox-downloader-extension.git
cd fanbox-downloader-extension
bun install
bun run build
```

1. `chrome://extensions` を開く
2. 「デベロッパーモード」を有効化
3. 「パッケージ化されていない拡張機能を読み込む」→ `dist/` ディレクトリを選択

## 使い方

1. FANBOX のクリエイターページ (`fanbox.cc/@creator`) または投稿ページ (`fanbox.cc/@creator/posts/123`) を開く
2. 右下の緑色の FAB ボタンをクリック
3. 設定パネルで必要に応じてオプションを変更
   - **無料コンテンツを除外**: 無料公開の投稿をスキップ (クリエイターページのみ)
   - **取得件数上限**: 取得する投稿数を制限 (クリエイターページのみ)
4. 「投稿を収集」をクリックすると、投稿の収集が始まる
5. 収集が終わると選択画面が出る。ダウンロードする投稿・添付の拡張子・カバー画像を絞り込む
6. 「ダウンロード開始」をクリックして保存先を選ぶと、ZIP の生成が始まる

保存先を選ぶのは選択画面の確定時である。
収集の前に選ばせると、収集に時間がかかったときに保存先だけ確保して何も書かないファイルが残りうる。

## 機能

- クリエイターの全投稿 または 単一投稿のダウンロード
- 収集後の絞り込み (投稿 × 添付の拡張子 × カバー画像)
- 対応コンテンツタイプ: 画像、ファイル、記事 (複合コンテンツ)、テキスト
- 投稿ごとのフォルダ分け、メタデータ JSON、HTML ページ生成
- ルート index.html でタグフィルタリング
- リトライ付きダウンロード
- SPA ナビゲーション対応 (ページ遷移で FAB が自動更新)
- Shadow DOM によるスタイル隔離 (FANBOX ページの CSS と干渉しない)

## 開発

```bash
bun install         # 依存関係インストール
bun run build       # ビルド (dist/ に出力)
bun run lint        # 静的解析・フォーマット
bun test            # ユニットテスト実行
bun run test:smoke  # 拡張の smoke test (Playwright, headless Chromium)
```

`bun run test:smoke` は拡張の smoke test を実行する。
テストビルド (`dist-test/`) を実際に Chromium (headless, WSL2 で動作確認済み) に読み込み、FAB クリックから収集・ZIP 生成までの一連の流れを検証する。
検証範囲は「収集の完走・全ファイル取得成功・ZIP の妥当性 (エントリ一致・EOCD の整合性)」までである。
実ファイルへの保存 (`showSaveFilePicker` はネイティブダイアログのためブラウザ自動化では扱えない) と、ZIP エントリの mtime 反映 (`test/downloader.test.ts` でカバー済み) は対象外である。
詳細は `CLAUDE.md` の「smoke test (Playwright)」を参照。

## 技術スタック

- TypeScript / Bun 1.3
- Chrome Manifest V3
- Biome 2.0 (リンター/フォーマッター)
- [download-helper](https://github.com/ValerianDillon/download-helper) (ZipWriter, HTML 生成)

## ライセンス

MIT
