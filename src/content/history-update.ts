import type { AssetKey, AssetWriteResult, DownloadManifest, PostSummary } from 'download-helper/download-helper';
import type {
  CatalogPost,
  CreatorHistoryUpdate,
  HistoryAsset,
  SavedAsset,
  SavedPost,
  ScanRecord,
} from '../history-record';
import { ARCHIVE_FORMAT_VERSION } from './archive-path';
import type { CollectResult } from './fanbox/collector';

/**
 * 収集結果を履歴の差分に写す (Issue #56)。
 *
 * 書き込みそのものは `./history.ts` が行う。ここは「収集で分かったことを履歴の形にする」だけを担う。
 */

/** `AssetKey` を履歴のアセット記述子の identity 部分に写す */
function toHistoryIdentity(key: AssetKey): { kind: HistoryAsset['kind']; assetId?: string } {
  return key.kind === 'cover' ? { kind: 'cover' } : { kind: key.kind, assetId: key.assetId };
}

/**
 * `metadata.size` を読む。
 *
 * 共有層は `size` を file 系のアセットにしか付けず、型でも区別しない (`AssetMetadata`)。
 * 非負の安全な整数でなければ無いものとして扱う — 履歴の復号が同じ条件で弾くので、
 * ここで通しても書き込んだ履歴が次回まるごと読めなくなるだけである。
 */
function toSize(metadata: Record<string, unknown>): number | undefined {
  const size = metadata.size;
  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function toHistoryAsset(summary: { key: AssetKey; name: string; extension: string; metadata: object }): HistoryAsset {
  const size = toSize(summary.metadata as Record<string, unknown>);
  const asset: HistoryAsset = {
    ...toHistoryIdentity(summary.key),
    originalName: summary.name,
    extension: summary.extension,
  };
  return size === undefined ? asset : { ...asset, size };
}

/**
 * 収集で取り込めた投稿を観測カタログに写す。
 *
 * **取り込めた投稿だけを載せる。** 一覧に現れたが取り込めなかった投稿を `complete: false` で
 * 載せても、`post.info` の省略条件は「カタログが完全」を求めるので結果は載せないのと変わらない。
 * 保存量が増えるだけである (`complete` の false は、同時刻の観測が食い違ったときにマージが
 * 倒す先として残っている)。
 *
 * `updatedDatetime` は一覧が返した値をそのまま持つ。`post.info` 側の値を使わないのは、
 * 次回の判定が一覧の走査だけで済むようにするためで、突き合わせる相手と同じ出所の値でなければ
 * 意味がない。
 * @param result 収集結果
 * @param observedAt この観測の時刻 (epoch ms)
 */
export function buildCatalog(result: CollectResult, observedAt: number): CatalogPost[] {
  return result.downloadObject.listPosts().map((post: PostSummary) => {
    const assets = post.cover ? [...post.files, post.cover] : [...post.files];
    return {
      postId: post.postId,
      observedAt,
      updatedDatetime: result.listedRevisions.get(post.postId) ?? null,
      title: post.name,
      publishedDatetime: post.publishedDatetime ?? null,
      complete: true,
      assets: assets.map(toHistoryAsset),
    };
  });
}

/**
 * 収集を走査実績に写す。creator 全体の走査でなければ null (記録してはいけない)。
 *
 * 単一投稿モードは一覧を見ていないので、走査実績を書くと「一覧から消えた投稿」の判断材料が
 * 実態と食い違う。
 * @param result 収集結果
 * @param scannedAt この走査の時刻 (epoch ms)
 */
export function buildScanRecord(result: CollectResult, scannedAt: number): ScanRecord | null {
  if (!result.scannedCreator) return null;
  return {
    completedFullScan: result.completedFullScan,
    failedPageCount: result.failedPageCount,
    stoppedReason: result.stoppedReason ?? null,
    limited: result.limited,
    scannedAt,
  };
}

/**
 * ZIP の書き込み結果を保存実績に写す (Issue #56)。
 *
 * **`DownloadZipResult.assets` は archive 名でしか結果を指さない。** 共有層は書き込み時に
 * identity を持っていないためである (ValerianDillon/download-helper#54)。
 * `AssetKey` への引き当ては `preflight` が返した manifest を引いて行う。
 *
 * **突き合わせのキーは投稿内の `archiveName` 単独。** `AssetWriteResult.kind` は
 * `'cover' | 'file'` で、`ManifestAsset.kind` の `'cover' | 'image' | 'file'` とは語彙が違い、
 * `file` が manifest 側の `image` と `file` の両方に対応するので絞り込めない。
 * 一意に決まる根拠は allocator が投稿内の archive 名の一意性を保証していること
 * (`assertUniqueNames`) なので、**一致が 1 件でなければ例外にする**。
 * 不変条件が破れたのを黙って通すと、別のアセットの保存実績として記録される。
 *
 * 中断由来 (`skipped`) は記録しない。書けたと確認できていないものを保存済みにしない。
 * 選択しなかったアセットも記録しない (理由は `SavedAssetOutcome` の JSDoc)。
 * @param manifest `preflight` が返した検証済みの manifest
 * @param assets `downloadZip` が返した対象単位の結果
 * @param listedRevisions 一覧が返した `updatedDatetime` (postId → 値)
 * @param zipName 保存先として利用者が選んだファイル名
 * @param savedAt ZIP の書き込みを終えた時刻 (epoch ms)
 * @throws {Error} archive 名から `AssetKey` を一意に引けない場合
 */
export function buildSavedPosts(
  manifest: DownloadManifest,
  assets: readonly AssetWriteResult[],
  listedRevisions: ReadonlyMap<string, string | null>,
  zipName: string,
  savedAt: number,
): SavedPost[] {
  const byPostIndex = new Map<number, SavedAsset[]>();
  for (const asset of assets) {
    if (asset.outcome === 'skipped') continue;
    const post = manifest.posts[asset.postIndex];
    if (post === undefined) {
      throw new Error(`書き込み結果の postIndex が manifest の範囲外です (${asset.postIndex})`);
    }
    const matched = post.included.filter((included) => included.archiveName === asset.archiveName);
    if (matched.length !== 1) {
      throw new Error(
        `archive 名から アセットを一意に引けません (${post.postId}: ${JSON.stringify(asset.archiveName)}, 一致 ${matched.length} 件)`,
      );
    }
    const identity =
      matched[0].kind === 'cover' ? { kind: 'cover' as const } : { kind: matched[0].kind, assetId: matched[0].assetId };
    const list = byPostIndex.get(asset.postIndex) ?? [];
    list.push({ ...identity, archiveName: asset.archiveName, outcome: asset.outcome, zipName, savedAt });
    byPostIndex.set(asset.postIndex, list);
  }
  // **アセットを 1 つも持たない投稿にも実績を作る。** 本文だけの投稿は `zip.assets` に
  // 現れないので、書き込み結果からだけ組み立てると保存実績が永久にできず、
  // 差分判定が一度も成立しない (カタログのアセットが空なら全件照合は成立するのに、
  // 実績が無いという理由だけで毎回 post.info を取り直すことになる)
  return manifest.posts.map((post, postIndex) => ({
    postId: post.postId,
    archiveDirectory: post.archiveDirectory,
    revision: listedRevisions.get(post.postId) ?? null,
    archiveFormatVersion: ARCHIVE_FORMAT_VERSION,
    savedAt,
    assets: byPostIndex.get(postIndex) ?? [],
  }));
}

/**
 * 収集と ZIP の結果を、履歴へ送る 1 つの差分にまとめる。
 *
 * 観測時刻には収集を終えた時刻 (`CollectResult.collectedAt`) を使い、保存時刻には ZIP を
 * 書き終えた時刻を使う。review 画面での選択に時間をかけると両者は大きく離れるので、
 * 観測を保存時刻で代用すると、遅れて保存した古い観測が新しい観測を上書きしうる。
 * @param creatorId 対象の creator
 * @param result 収集結果
 * @param manifest `preflight` が返した検証済みの manifest
 * @param zipAssets `downloadZip` が返した対象単位の結果
 * @param zipName 保存先のファイル名
 * @param savedAt ZIP の書き込みを終えた時刻 (epoch ms)
 */
export function buildHistoryUpdate(
  creatorId: string,
  result: CollectResult,
  manifest: DownloadManifest,
  zipAssets: readonly AssetWriteResult[],
  zipName: string,
  savedAt: number,
): CreatorHistoryUpdate {
  const scan = buildScanRecord(result, result.collectedAt);
  const update: CreatorHistoryUpdate = {
    creatorId,
    at: savedAt,
    catalog: buildCatalog(result, result.collectedAt),
    saved: buildSavedPosts(manifest, zipAssets, result.listedRevisions, zipName, savedAt),
  };
  return scan === null ? update : { ...update, scan };
}
