import type { ArchivePathAllocator, DownloadObjectSnapshot } from 'download-helper/download-helper';
import { DownloadObject, type DownloadUtils } from 'download-helper/download-helper';
import type { CreatorHistory } from '../history-record';
import type { CollectResult, PostFailureCounts } from './fanbox/collector';

export const COLLECTION_FILE_SCHEMA_VERSION = 1;
export const COLLECTION_FILE_KIND = 'fanbox-downloader-collection';

/** 選択前の投稿情報を別セッションへ持ち運ぶファイル。保存履歴は別の SoT なので含めない。 */
export type CollectionFile = {
  readonly schemaVersion: typeof COLLECTION_FILE_SCHEMA_VERSION;
  readonly kind: typeof COLLECTION_FILE_KIND;
  readonly exportedAt: string;
  readonly creatorId: string;
  readonly collectedAt: number;
  readonly collection: DownloadObjectSnapshot;
  readonly listedRevisions: readonly (readonly [postId: string, revision: string | null])[];
  readonly postFailures: PostFailureCounts;
  readonly failedPageCount: number;
  readonly stoppedReason?: 'rate-limit-exhausted' | 'transport-exhausted';
  readonly scannedCreator: boolean;
  readonly completedFullScan: boolean;
  readonly limited: boolean;
};

/** 現在の収集結果を、再び review へ戻せる canonical JSON 値へ写す。 */
export function createCollectionFile(creatorId: string, result: CollectResult, now = new Date()): CollectionFile {
  return {
    schemaVersion: COLLECTION_FILE_SCHEMA_VERSION,
    kind: COLLECTION_FILE_KIND,
    exportedAt: now.toISOString(),
    creatorId,
    collectedAt: result.collectedAt,
    collection: result.downloadObject.exportSnapshot(),
    listedRevisions: [...result.listedRevisions.entries()].map(([postId, revision]) => [postId, revision]),
    postFailures: { ...result.postFailures },
    failedPageCount: result.failedPageCount,
    ...(result.stoppedReason === undefined ? {} : { stoppedReason: result.stoppedReason }),
    scannedCreator: result.scannedCreator,
    completedFullScan: result.completedFullScan,
    limited: result.limited,
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} が object ではありません`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} が string ではありません`);
  return value;
}

function count(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} が非負の安全な整数ではありません`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} が boolean ではありません`);
  return value;
}

function denseArray<T>(value: unknown, path: string, decode: (item: unknown, itemPath: string) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`${path} が array ではありません`);
  const result: T[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) throw new Error(`${path}[${index}] が欠落しています`);
    result.push(decode(value[index], `${path}[${index}]`));
  }
  return result;
}

function decodePostFailures(value: unknown): PostFailureCounts {
  const source = record(value, 'postFailures');
  return {
    unavailable: count(source.unavailable, 'postFailures.unavailable'),
    unavailableRestricted: count(source.unavailableRestricted, 'postFailures.unavailableRestricted'),
    unavailableMissingBody: count(source.unavailableMissingBody, 'postFailures.unavailableMissingBody'),
    unsupported: count(source.unsupported, 'postFailures.unsupported'),
    apiFailed: count(source.apiFailed, 'postFailures.apiFailed'),
  };
}

/**
 * 外部ファイルを検証し、通常の review が扱う CollectResult へ復元する。
 *
 * 保存履歴はファイルに含めず、現在の storage から読んだ値を注入する。
 */
export function restoreCollectionFile(
  value: unknown,
  utils: DownloadUtils,
  allocator: ArchivePathAllocator,
  historyUsed: CreatorHistory | null,
): { creatorId: string; result: CollectResult } {
  try {
    const source = record(value, 'root');
    if (source.schemaVersion !== COLLECTION_FILE_SCHEMA_VERSION || source.kind !== COLLECTION_FILE_KIND) {
      throw new Error('schemaVersion または kind が対応形式ではありません');
    }
    const exportedAt = string(source.exportedAt, 'exportedAt');
    if (!Number.isFinite(new Date(exportedAt).getTime())) throw new Error('exportedAt が有効な日時ではありません');
    const creatorId = string(source.creatorId, 'creatorId');
    const listedRevisions = new Map<string, string | null>();
    for (const [postId, revision] of denseArray(source.listedRevisions, 'listedRevisions', (item, path) => {
      if (!Array.isArray(item) || item.length !== 2) throw new Error(`${path} が [postId, revision] ではありません`);
      const decodedPostId = string(item[0], `${path}[0]`);
      const decodedRevision = item[1] === null ? null : string(item[1], `${path}[1]`);
      return [decodedPostId, decodedRevision] as const;
    })) {
      if (listedRevisions.has(postId)) throw new Error(`listedRevisions に重複した postId があります (${postId})`);
      listedRevisions.set(postId, revision);
    }
    const stoppedReason = source.stoppedReason;
    if (
      stoppedReason !== undefined &&
      stoppedReason !== 'rate-limit-exhausted' &&
      stoppedReason !== 'transport-exhausted'
    ) {
      throw new Error('stoppedReason が対応値ではありません');
    }
    const downloadObject = DownloadObject.fromSnapshot(source.collection, utils, allocator);
    if (downloadObject.exportSnapshot().id !== creatorId) {
      throw new Error('creatorId と collection.id が一致しません');
    }
    const posts = downloadObject.listPosts();
    return {
      creatorId,
      result: {
        downloadObject,
        addedPostCount: posts.length,
        postFailures: decodePostFailures(source.postFailures),
        failedPageCount: count(source.failedPageCount, 'failedPageCount'),
        listedRevisions,
        apiFailedPostIds: new Set(),
        skippedByHistoryPostIds: new Set(),
        collectedAt: count(source.collectedAt, 'collectedAt'),
        ...(stoppedReason === undefined ? {} : { stoppedReason }),
        scannedCreator: boolean(source.scannedCreator, 'scannedCreator'),
        completedFullScan: boolean(source.completedFullScan, 'completedFullScan'),
        limited: boolean(source.limited, 'limited'),
        historyUsed,
      },
    };
  } catch (error) {
    throw new Error(`投稿情報ファイルを読み込めません: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}
