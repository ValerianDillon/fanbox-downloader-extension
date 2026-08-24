import { assetKeyToString, type DownloadUtils } from 'download-helper/download-helper';
import type { CreatorHistory, SavedPost } from '../history-record';
import { ARCHIVE_FORMAT_VERSION, createPostIdArchivePathAllocator, type FrozenArchiveNames } from './archive-path';

/**
 * 履歴から今回の収集の計画を決める (Issue #56)。
 *
 * 収集結果を履歴に写す向き (`./history-update.ts`) とは逆で、こちらは履歴を読んで
 * 「どの投稿の `post.info` を省けるか」と「どの名前を据え置くか」を決める。
 */

/**
 * 保存実績を凍結名に写す。
 *
 * **`ARCHIVE_FORMAT_VERSION` が現行と違う投稿は含めない。** 記録された版は「その名前を
 * 決めたときの採番規則」なので、規則が変わっていれば同じ名前を作り直すことはできない。
 * その投稿は現行の規則で採番し直され、過去の ZIP との同定は失われる (版を記録しているのは
 * まさにそれを検出するためである)。
 *
 * 名前が凍結名として使えるかは allocator が受け取った時点で検査する。ここでは選り分けない。
 */
export function buildFrozenArchiveNames(history: CreatorHistory): FrozenArchiveNames {
  const postDirectories = new Map<string, string>();
  const assetNames = new Map<string, Map<string, string>>();
  for (const post of history.saved) {
    if (post.archiveFormatVersion !== ARCHIVE_FORMAT_VERSION) continue;
    postDirectories.set(post.postId, post.archiveDirectory);
    const names = new Map<string, string>();
    for (const asset of post.assets) {
      const key =
        asset.kind === 'cover' ? { kind: 'cover' as const } : { kind: asset.kind, assetId: asset.assetId ?? '' };
      names.set(assetKeyToString(key), asset.archiveName);
    }
    assetNames.set(post.postId, names);
  }
  return { postDirectories, assetNames };
}

/**
 * 履歴を使う収集の準備。凍結名を使えなければ履歴ごと無いものとして扱う。
 *
 * **凍結名が allocator に拒否されたら、その履歴は使えない。** `archive-name-rules.ts` は
 * 共有層の `DownloadUtils` を要する正規化の判定だけを持てないので、復号を通っても
 * allocator が弾く名前が残りうる。ここで捕らえずに投げさせると、**破損した履歴が次の
 * ダウンロードごと止める**。
 *
 * 履歴を無いものとして扱うのは差分判定も含めてである。名前を作り直すと決めた履歴を
 * 根拠に `post.info` を省くと、省いた投稿と作り直した名前の対応が取れなくなる。
 * @param utils 採番に使うユーティリティ
 * @param history 読み出した履歴 (無ければ null)
 */
export function prepareHistoryPlan(
  utils: DownloadUtils,
  history: CreatorHistory | null,
): { allocator: ReturnType<typeof createPostIdArchivePathAllocator>; history: CreatorHistory | null } {
  if (history === null) return { allocator: createPostIdArchivePathAllocator(utils), history: null };
  try {
    return {
      allocator: createPostIdArchivePathAllocator(utils, buildFrozenArchiveNames(history)),
      history,
    };
  } catch (e) {
    console.warn('凍結名を使えないため、履歴が無いものとして収集します:', e);
    return { allocator: createPostIdArchivePathAllocator(utils), history: null };
  }
}

/**
 * その投稿の `post.info` を省略してよいか (Issue #56)。
 *
 * 次の 4 つがすべて揃うときだけ省略できる。
 *
 * 1. 一覧の `updatedDatetime` が前回の記録と同じ (文字列の完全一致)
 * 2. カタログが完全である
 * 3. カタログに載っている全アセットに `written` の保存実績がある
 * 4. 保存実績の `ARCHIVE_FORMAT_VERSION` が現行と一致する
 *
 * **3 が Issue の「今回選択された全対象について保存実績がある」の代わりである。**
 * 選択は収集が終わってから決まるので、収集中のこの判断には使えない。前回書けなかった
 * アセットが 1 つでもあれば省略しない、という要求は「全アセットが `written`」で満たされる
 * (前回選択しなかったアセットには実績が無いので、これも省略しない側に倒れる)。
 *
 * `updatedDatetime` の比較は文字列の完全一致で行う。パースして時刻として比べると、
 * タイムゾーン表記や秒未満の桁のゆれで偽の一致・不一致が出る。
 * どちらかが `null` (取得できなかった) なら一致とみなさない。
 * @param history 読み出した履歴
 * @param postId 対象の投稿
 * @param listedUpdatedDatetime 今回の一覧が返した値 (読めなければ null)
 */
export function canSkipPostInfo(
  history: CreatorHistory | null,
  postId: string,
  listedUpdatedDatetime: string | null,
): boolean {
  if (history === null || listedUpdatedDatetime === null) return false;
  const catalog = history.catalog.find((post) => post.postId === postId);
  if (catalog === undefined || !catalog.complete) return false;
  if (catalog.updatedDatetime !== listedUpdatedDatetime) return false;
  const saved = history.saved.find((post) => post.postId === postId);
  if (saved === undefined || saved.archiveFormatVersion !== ARCHIVE_FORMAT_VERSION) return false;
  if (saved.revision !== listedUpdatedDatetime) return false;
  return catalog.assets.every((asset) => hasWrittenRecord(saved, asset.kind, asset.assetId));
}

function hasWrittenRecord(saved: SavedPost, kind: string, assetId: string | undefined): boolean {
  return saved.assets.some((asset) => asset.outcome === 'written' && asset.kind === kind && asset.assetId === assetId);
}

/**
 * 収集に渡してよい履歴を選ぶ (Issue #56)。
 *
 * **creator の一致を必ず確かめる。** FANBOX は SPA なので、履歴を読み込んでから収集を
 * 始めるまでの間に別の creator へ遷移しうる。creator の違う履歴を渡すと、postId が
 * たまたま一致した投稿について**別の creator の保存実績を根拠に `post.info` を省く**。
 *
 * 「前回保存分も取得する」の指定はここでは見ない。**再取得の指定は凍結名を捨てる理由に
 * ならない**ためで、その指定は `collect` の `skipPreviouslySaved` が受け取る。
 * 混ぜると、再取得を選んだだけで投稿とアセットの archive 名が付け替わる。
 * @param history 読み込み済みの履歴
 * @param creatorId これから収集する creator
 */
export function historyForCollect(history: CreatorHistory | null, creatorId: string): CreatorHistory | null {
  return history?.creatorId === creatorId ? history : null;
}

/**
 * 収集に使う履歴を取り直す (Issue #56)。
 *
 * **進行中の削除を待ってから読む。** 待たずに読むと、削除がまだ適用されていない storage を
 * 読んで「削除したはずの履歴」で `post.info` を省く (確認文の「次回は全件を取得します」に反する)。
 * 削除ボタンを無効にするだけでは、収集ボタンは押せるので防げない。
 *
 * 画面が持っている値を使わないのは、別のタブで削除されてもこちらのメモリ上の履歴は
 * 消えないためである。
 * @param pendingDelete このタブで進行中の削除の応答 (無ければ undefined)
 * @param read storage から読む処理
 */
export async function acquireHistoryForCollect(
  pendingDelete: Promise<unknown> | undefined,
  read: () => Promise<CreatorHistory | null>,
): Promise<CreatorHistory | null> {
  await pendingDelete;
  return read();
}
