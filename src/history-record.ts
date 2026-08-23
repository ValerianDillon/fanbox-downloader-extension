/**
 * 差分ダウンロードの履歴レコード (Issue #56)。
 *
 * content script と service worker の両方が読むので、型・キー導出・マージ規則・復号を
 * ここに集約する (`media-stream-protocol.ts` と同じ位置づけ)。
 * 保存先の I/O と直列化は `service-worker/history-store.ts` が持つ。
 *
 * **拡張が主張できるのは「この拡張が日時 X の ZIP 生成で当該エントリの書き込み完了を確認した」
 * という事実だけである。** その ZIP が現在も存在する、展開後のファイルが存在する、とは主張しない。
 */

/**
 * 保存形式の版。互換性のない変更のたびに上げる。
 *
 * 読み出しで一致しなければ履歴を「無い」ものとして扱う。古い形を読もうとして誤った差分判定を
 * するより、再ダウンロードになる方 (安全側) に倒す。
 */
export const HISTORY_SCHEMA_VERSION = 1;

/**
 * creator ごとのレコードのキー接頭辞。
 *
 * 接頭辞は固定長なので、`<接頭辞><creatorId>` は creatorId について単射である
 * (別の creator が同じキーへ潰れない)。版はキーではなくレコードに載せる。キーに載せると
 * 版を上げたときに古いキーが誰にも読まれないまま残り続ける。
 */
export const HISTORY_KEY_PREFIX = 'fbdlHistory:';

/**
 * 履歴に使ってよい合計バイト数。
 *
 * `chrome.storage.local` の既定容量は 10 MiB で、Issue #51 の観測記録 (`fbdlMediaAttempts`) と
 * 共有する。余裕を残して 8 MiB を上限とし、超えたら creator 単位で古い方から捨てる。
 * `unlimitedStorage` を足すかは実測してから決める。
 */
export const HISTORY_BUDGET_BYTES = 8 * 1024 * 1024;

/** creator のレコードのキーを求める */
export function historyKeyFor(creatorId: string): string {
  return `${HISTORY_KEY_PREFIX}${creatorId}`;
}

/** 履歴のキーなら creatorId を返す。違うキーなら null */
export function creatorIdFromHistoryKey(key: string): string | null {
  if (!key.startsWith(HISTORY_KEY_PREFIX)) return null;
  const creatorId = key.slice(HISTORY_KEY_PREFIX.length);
  return creatorId === '' ? null : creatorId;
}

/** アセットの種別。共有層の `AssetKey.kind` と同じ語彙 */
export type HistoryAssetKind = 'cover' | 'image' | 'file';

/**
 * 観測カタログのアセット記述子。
 *
 * `AssetKey` と同じ形 (kind + assetId、cover は assetId を持たない) にする。
 * `assetKeyToString` の結果を保存しないのは、共有層の符号化に依存すると、そちらが変わったときに
 * 過去のレコードの意味が変わるため。
 *
 * **URL は保存しない。** 必要になれば `post.info` を取り直せば得られるし、
 * `https://downloads.fanbox.cc/...` の組み立て規則を拡張側の契約にしない。
 */
export type HistoryAsset = {
  readonly kind: HistoryAssetKind;
  /** cover は持たない */
  readonly assetId?: string;
  readonly originalName: string;
  readonly extension: string;
  /** file 系のアセットにしか無い */
  readonly size?: number;
};

/** 観測カタログの投稿 1 件 */
export type CatalogPost = {
  readonly postId: string;
  /**
   * 一覧 (`post.listCreator`) が返した `updatedDatetime` を検証したもの。
   * 欠落や型不正なら null で、そのときは差分判定に使わない (通常の取得へフォールバックする)。
   */
  readonly updatedDatetime: string | null;
  readonly title: string;
  readonly publishedDatetime: string | null;
  readonly feeRequired: number | null;
  /**
   * カタログが完全か。`post.info` を実際に取り込めた投稿だけ true になる。
   * 一覧の情報だけで飛ばした投稿・取得に失敗した投稿は false で、`post.info` の省略対象にしない。
   */
  readonly complete: boolean;
  readonly assets: readonly HistoryAsset[];
};

/**
 * アセット 1 件の保存結果。
 *
 * `skipped` (中断) は持たない。中断で終わった実行はそもそも記録しないので、
 * 「中断で書けなかった」という状態がレコードに現れることはない。
 */
export type SavedAssetOutcome = 'written' | 'failed' | 'not-selected';

/**
 * 保存実績のアセット 1 件。
 *
 * **保存元 (`zipName`) と保存時刻 (`savedAt`) はアセットごとに持つ。** 同じ投稿の一部だけを
 * 別の ZIP で取り直せるので、投稿側にまとめると「ZIP A で書いたアセット」が「ZIP B で書いた」
 * ことになってしまう。拡張が主張してよいのは実際に確認した書き込みだけである。
 */
export type SavedAsset = {
  readonly kind: HistoryAssetKind;
  /** cover は持たない */
  readonly assetId?: string;
  /** 投稿ディレクトリからの相対名。凍結名として次回の allocator に渡す */
  readonly archiveName: string;
  readonly outcome: SavedAssetOutcome;
  /** この結果を出した ZIP のファイル名 */
  readonly zipName: string;
  /** この結果を出した ZIP の書き込みを終えた時刻 (epoch ms) */
  readonly savedAt: number;
};

/** 保存実績の投稿 1 件 */
export type SavedPost = {
  readonly postId: string;
  /** 投稿ディレクトリ名。凍結名として次回の allocator に渡す */
  readonly archiveDirectory: string;
  /**
   * 保存した時点の `updatedDatetime`。
   * これが今回の一覧の値と違えば投稿が編集されているので、過去の保存実績は使えない。
   */
  readonly revision: string | null;
  /** 保存した時点の `ARCHIVE_FORMAT_VERSION`。違えば過去の ZIP は別の場所に入っている */
  readonly archiveFormatVersion: number;
  readonly assets: readonly SavedAsset[];
};

/**
 * 一覧の走査の実績。
 *
 * 全ページを完走していない scan、件数の上限が付いた scan、ページの取得に失敗した scan では、
 * 一覧から消えた投稿を削除として扱ってはいけない。その判断材料になる。
 */
export type ScanRecord = {
  /** 全ページを走査し終えたか */
  readonly completedFullScan: boolean;
  readonly failedPageCount: number;
  /** 打ち切った理由 (`CollectResult.stoppedReason`)。完走したなら null */
  readonly stoppedReason: string | null;
  /** 取得件数の上限が付いていたか */
  readonly limited: boolean;
  readonly scannedAt: number;
};

/** creator 1 件ぶんの履歴 */
export type CreatorHistory = {
  readonly schemaVersion: number;
  readonly creatorId: string;
  /** LRU 破棄の順序に使う */
  readonly lastUsedAt: number;
  readonly catalog: readonly CatalogPost[];
  readonly saved: readonly SavedPost[];
  readonly scan: ScanRecord | null;
};

/**
 * content script が service worker へ送る差分。
 *
 * **creator レコード全体ではなく差分を送る。** 全体を送って上書きすると、同じ creator を
 * 2 タブで開いたときに片方の更新が他方を丸ごと巻き戻す。
 * 時刻は送る側が刻む。service worker 側で `Date.now()` を読むと、同じ差分の再送で結果が変わる。
 */
export type CreatorHistoryUpdate = {
  readonly creatorId: string;
  /** この更新の時刻 (epoch ms)。`lastUsedAt` に反映する */
  readonly at: number;
  /** postId 単位で upsert する */
  readonly catalog?: readonly CatalogPost[];
  /** postId 単位で upsert する (revision・版・投稿ディレクトリが一致すればアセットをマージ、違えば置換) */
  readonly saved?: readonly SavedPost[];
  /** より新しい `scannedAt` のときだけ置き換える */
  readonly scan?: ScanRecord;
};

/** 空の履歴 */
export function emptyCreatorHistory(creatorId: string, at: number): CreatorHistory {
  return { schemaVersion: HISTORY_SCHEMA_VERSION, creatorId, lastUsedAt: at, catalog: [], saved: [], scan: null };
}

/** アセットを投稿内で同定する鍵。`kind` と `assetId` の組が identity である */
function assetIdentity(asset: { readonly kind: HistoryAssetKind; readonly assetId?: string }): string {
  return asset.kind === 'cover' ? 'cover' : `${asset.kind}:${asset.assetId ?? ''}`;
}

/** 同じ鍵が 2 度現れるか */
function hasDuplicate<T>(items: readonly T[], keyOf: (item: T) => string): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * 差分の中に同じ postId・同じアセット identity が 2 度現れないことを確かめる。
 *
 * **重複があると upsert の結果が適用回数に依存する** (既存に無いうちは先に現れた方が残り、
 * 既に取り込まれた後は後に現れた方で置き換わる)。冪等でなくなるので、曖昧な入力は受け取らない。
 * 収集は `collector.ts` の `seenPostIds` で投稿の重複を除いているので、ここに重複が来るのは
 * 組み立て側の不具合であり、黙って片方を採るより失敗させる方が実態に合う。
 */
function assertNoDuplicates(update: CreatorHistoryUpdate): void {
  if (hasDuplicate(update.catalog ?? [], (post) => post.postId)) {
    throw new Error('履歴の差分に同じ postId のカタログが複数あります');
  }
  if (hasDuplicate(update.saved ?? [], (post) => post.postId)) {
    throw new Error('履歴の差分に同じ postId の保存実績が複数あります');
  }
  for (const post of update.catalog ?? []) {
    if (hasDuplicate(post.assets, assetIdentity)) {
      throw new Error(`履歴の差分に同じアセットが複数あります (カタログ ${post.postId})`);
    }
  }
  for (const post of update.saved ?? []) {
    if (hasDuplicate(post.assets, assetIdentity)) {
      throw new Error(`履歴の差分に同じアセットが複数あります (保存実績 ${post.postId})`);
    }
  }
}

/**
 * postId をキーに upsert し、既存の並びを保ったまま新しいものを末尾に足す。
 * 並びを保つのは、同じ入力に対して同じレコードが出るようにするため (差分の再送で内容が揺れない)。
 *
 * 双方に postId の重複が無いことが前提である (`assertNoDuplicates` と `decodeCreatorHistory` が保証する)。
 */
function upsertByPostId<T extends { readonly postId: string }>(
  current: readonly T[],
  incoming: readonly T[],
  merge: (existing: T, next: T) => T,
): readonly T[] {
  if (incoming.length === 0) return current;
  const byPostId = new Map(incoming.map((item) => [item.postId, item]));
  const result: T[] = [];
  const consumed = new Set<string>();
  for (const existing of current) {
    const next = byPostId.get(existing.postId);
    if (next === undefined) {
      result.push(existing);
      continue;
    }
    consumed.add(existing.postId);
    result.push(merge(existing, next));
  }
  for (const item of incoming) {
    if (consumed.has(item.postId)) continue;
    result.push(item);
  }
  return result;
}

/**
 * 同じアセットの結果が 2 つあるとき、どちらを残すか決める。
 *
 * **新しい方 (`savedAt` が大きい方) を残す。** 到着順で決めると、遅れて届いた古い差分が
 * 新しい結果を巻き戻す。`written` から `failed` へ落ちる向きも許す — 履歴が欠けて
 * 再ダウンロードになるのは安全側だからである。
 *
 * 時刻が同じなら `written` でない方を残す。同じ時刻に別の結果が 2 つ出るのは想定していないが、
 * 決め方を残しておかないと結果が入力の並びに依存する。
 */
function preferSavedAsset(existing: SavedAsset, next: SavedAsset): SavedAsset {
  if (next.savedAt !== existing.savedAt) return next.savedAt > existing.savedAt ? next : existing;
  if (existing.outcome === 'written' && next.outcome !== 'written') return next;
  if (next.outcome === 'written' && existing.outcome !== 'written') return existing;
  return next;
}

/**
 * 同じ投稿の保存実績を統合する。
 *
 * revision (= 保存時の `updatedDatetime`)・`ARCHIVE_FORMAT_VERSION`・投稿ディレクトリ名が
 * すべて一致するときだけアセットをマージする。**1 つでも違えば過去の実績は使えない**ので
 * 丸ごと置き換える。投稿が編集されていればアセットの構成が変わっており、採番規則や
 * ディレクトリ名が変わっていれば過去の ZIP は別の場所に入っている。
 *
 * マージするのは、前回失敗した対象だけを再試行したときに前回成功した対象の実績を失わないため。
 */
function mergeSavedPost(existing: SavedPost, next: SavedPost): SavedPost {
  if (
    existing.revision !== next.revision ||
    existing.archiveFormatVersion !== next.archiveFormatVersion ||
    existing.archiveDirectory !== next.archiveDirectory
  ) {
    return next;
  }
  const byIdentity = new Map(next.assets.map((asset) => [assetIdentity(asset), asset]));
  const assets: SavedAsset[] = [];
  const consumed = new Set<string>();
  for (const asset of existing.assets) {
    const identity = assetIdentity(asset);
    const replacement = byIdentity.get(identity);
    if (replacement === undefined) {
      assets.push(asset);
      continue;
    }
    consumed.add(identity);
    assets.push(preferSavedAsset(asset, replacement));
  }
  for (const asset of next.assets) {
    if (consumed.has(assetIdentity(asset))) continue;
    assets.push(asset);
  }
  return { ...next, assets };
}

/**
 * 差分を適用した新しい履歴を返す。入力は変更しない。
 *
 * **冪等である。** 同じ差分を 2 回適用しても結果は変わらない (postId とアセットの identity で
 * upsert し、時刻は新しい方を採るため)。service worker は応答の直前に停止しうるので、
 * content script が同じ差分を送り直す経路がある。
 *
 * カタログには観測時刻を持たせない。遅れて届いた古いカタログが新しいカタログを置き換えても、
 * `post.info` の省略条件 (一覧の `updatedDatetime` との一致・カタログが完全・全対象に保存実績)
 * はどれも緩まないため、余分に取り直す方向にしか倒れない。
 * @throws {Error} 差分の中に同じ postId・同じアセットが複数ある場合
 */
export function mergeCreatorHistory(current: CreatorHistory | null, update: CreatorHistoryUpdate): CreatorHistory {
  assertNoDuplicates(update);
  const base = current ?? emptyCreatorHistory(update.creatorId, update.at);
  // scan も新しい方を採る。無条件に置き換えると、遅れて届いた古い差分が「全ページ走査した」を
  // 巻き戻したり、逆に古い「完走した」で新しい「打ち切った」を上書きしたりする
  const scan =
    update.scan !== undefined && (base.scan === null || update.scan.scannedAt >= base.scan.scannedAt)
      ? update.scan
      : base.scan;
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    creatorId: update.creatorId,
    lastUsedAt: Math.max(base.lastUsedAt, update.at),
    catalog: upsertByPostId(base.catalog, update.catalog ?? [], (_existing, next) => next),
    saved: upsertByPostId(base.saved, update.saved ?? [], mergeSavedPost),
    scan,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** 非負の安全な整数か */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decodeAssetKind(value: unknown): HistoryAssetKind | undefined {
  return value === 'cover' || value === 'image' || value === 'file' ? value : undefined;
}

/**
 * `kind` と `assetId` の組を復号する。
 * cover は `assetId` を持ってはならず、それ以外は非空の `assetId` が要る
 * (identity が壊れたレコードを通すと、別のアセットを同一視しうる)。
 */
function decodeAssetIdentity(source: Record<string, unknown>): { kind: HistoryAssetKind; assetId?: string } | null {
  const kind = decodeAssetKind(source.kind);
  if (kind === undefined) return null;
  if (kind === 'cover') return source.assetId === undefined ? { kind } : null;
  return typeof source.assetId === 'string' && source.assetId !== '' ? { kind, assetId: source.assetId } : null;
}

function decodeHistoryAsset(value: unknown): HistoryAsset | null {
  if (!isRecord(value)) return null;
  const identity = decodeAssetIdentity(value);
  if (identity === null) return null;
  if (typeof value.originalName !== 'string' || typeof value.extension !== 'string') return null;
  if (value.size !== undefined && !isCount(value.size)) return null;
  const asset: HistoryAsset = { ...identity, originalName: value.originalName, extension: value.extension };
  return value.size === undefined ? asset : { ...asset, size: value.size };
}

function decodeCatalogPost(value: unknown): CatalogPost | null {
  if (!isRecord(value)) return null;
  if (typeof value.postId !== 'string' || value.postId === '') return null;
  const updatedDatetime = optionalString(value.updatedDatetime);
  const publishedDatetime = optionalString(value.publishedDatetime);
  if (updatedDatetime === undefined || publishedDatetime === undefined) return null;
  if (typeof value.title !== 'string' || typeof value.complete !== 'boolean') return null;
  if (value.feeRequired !== null && !isCount(value.feeRequired)) return null;
  const assets = decodeArray(value.assets, decodeHistoryAsset);
  if (assets === null || hasDuplicate(assets, assetIdentity)) return null;
  return {
    postId: value.postId,
    updatedDatetime,
    title: value.title,
    publishedDatetime,
    feeRequired: value.feeRequired as number | null,
    complete: value.complete,
    assets,
  };
}

function decodeSavedAsset(value: unknown): SavedAsset | null {
  if (!isRecord(value)) return null;
  const identity = decodeAssetIdentity(value);
  if (identity === null) return null;
  if (typeof value.archiveName !== 'string' || value.archiveName === '') return null;
  const outcome = value.outcome;
  if (outcome !== 'written' && outcome !== 'failed' && outcome !== 'not-selected') return null;
  if (typeof value.zipName !== 'string' || !isCount(value.savedAt)) return null;
  return { ...identity, archiveName: value.archiveName, outcome, zipName: value.zipName, savedAt: value.savedAt };
}

function decodeSavedPost(value: unknown): SavedPost | null {
  if (!isRecord(value)) return null;
  if (typeof value.postId !== 'string' || value.postId === '') return null;
  if (typeof value.archiveDirectory !== 'string' || value.archiveDirectory === '') return null;
  const revision = optionalString(value.revision);
  if (revision === undefined) return null;
  if (!isCount(value.archiveFormatVersion)) return null;
  const assets = decodeArray(value.assets, decodeSavedAsset);
  if (assets === null || hasDuplicate(assets, assetIdentity)) return null;
  return {
    postId: value.postId,
    archiveDirectory: value.archiveDirectory,
    revision,
    archiveFormatVersion: value.archiveFormatVersion,
    assets,
  };
}

function decodeScanRecord(value: unknown): ScanRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.completedFullScan !== 'boolean' || typeof value.limited !== 'boolean') return null;
  if (!isCount(value.failedPageCount) || !isCount(value.scannedAt)) return null;
  const stoppedReason = optionalString(value.stoppedReason);
  if (stoppedReason === undefined) return null;
  return {
    completedFullScan: value.completedFullScan,
    failedPageCount: value.failedPageCount,
    stoppedReason,
    limited: value.limited,
    scannedAt: value.scannedAt,
  };
}

/** 1 件でも復号できなければ配列全体を捨てる (欠けた配列を「これで全部」と扱わないため) */
function decodeArray<T>(value: unknown, decode: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  const decoded: T[] = [];
  for (const item of value) {
    const one = decode(item);
    if (one === null) return null;
    decoded.push(one);
  }
  return decoded;
}

/**
 * 保存されている値を履歴として復号する。読めなければ null を返す。
 *
 * **読めない値は「履歴が無い」に倒す。** 壊れた記録や古い版を部分的に信じると、実際には保存して
 * いない対象を「前回保存済み」として飛ばしうる。無いものとして扱えば再ダウンロードになるだけである。
 *
 * `expectedCreatorId` を必ず突き合わせる。キーと中身がずれたレコード (壊れた記録、書き込み先の
 * 取り違え) をそのまま返すと、**別の creator の保存実績を今の creator のものとして扱う**。
 * postId とアセットの identity が一致すれば、保存していないアセットを保存済みと判定しうる。
 *
 * postId とアセットの重複も拒否する。重複があると upsert の結果が適用回数に依存し、冪等でなくなる。
 * @param value 保存されている値
 * @param expectedCreatorId このレコードが属するはずの creator (キーから求めたもの)
 */
export function decodeCreatorHistory(value: unknown, expectedCreatorId: string): CreatorHistory | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== HISTORY_SCHEMA_VERSION) return null;
  if (typeof value.creatorId !== 'string' || value.creatorId !== expectedCreatorId) return null;
  if (!isCount(value.lastUsedAt)) return null;
  const catalog = decodeArray(value.catalog, decodeCatalogPost);
  const saved = decodeArray(value.saved, decodeSavedPost);
  if (catalog === null || saved === null) return null;
  if (hasDuplicate(catalog, (post) => post.postId) || hasDuplicate(saved, (post) => post.postId)) return null;
  const scan = value.scan === null ? null : decodeScanRecord(value.scan);
  if (value.scan !== null && scan === null) return null;
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    creatorId: value.creatorId,
    lastUsedAt: value.lastUsedAt,
    catalog,
    saved,
    scan,
  };
}

/**
 * 保存されている 1 エントリが占める容量の見積もり (UTF-8 バイト数)。
 *
 * `chrome.storage.local` の課金単位はキーと JSON 文字列の長さなので、それをそのまま数える。
 * `getBytesInUse` を使わないのは、キーごとの内訳を得るには 1 キーずつ往復する必要があるためである。
 * 厳密な一致は要らない (上限に余裕を取ってある)。
 */
export function estimateEntryBytes(key: string, value: unknown): number {
  return new TextEncoder().encode(key + JSON.stringify(value ?? null)).length;
}

/**
 * content script から service worker へ送るメッセージ。
 *
 * **書き込みだけが service worker を経由する。** 読み出しは content script が
 * `chrome.storage.local` を直接引く (`get` は atomic なので書き込み途中の状態は見えない)。
 * 読みまで往復にすると、収集の入口で service worker の起動待ちが入る。
 */
export type HistoryMessage =
  | { readonly type: 'historyApply'; readonly update: CreatorHistoryUpdate }
  | { readonly type: 'historyRemove'; readonly creatorId: string };

/**
 * service worker の応答。
 *
 * 失敗を握りつぶさないのは、「ZIP は保存したが履歴の更新に失敗した」を利用者に表示するため。
 */
export type HistoryResponse = { readonly ok: boolean; readonly error?: string };

/**
 * 受け取った値を差分として復号する。読めなければ null。
 *
 * **ワイヤ境界では TypeScript の型が保証にならない。** ここで完全に復号しておくことで、
 * 保存されるレコードが構築の時点で常に整った形になる。緩く通して `decodeCreatorHistory` の
 * 側で弾く形にすると、書き込みは成功したのに次回の読み出しで履歴ごと捨てることになる。
 */
export function decodeCreatorHistoryUpdate(value: unknown): CreatorHistoryUpdate | null {
  if (!isRecord(value)) return null;
  if (typeof value.creatorId !== 'string' || value.creatorId === '') return null;
  if (!isCount(value.at)) return null;
  const update: {
    creatorId: string;
    at: number;
    catalog?: readonly CatalogPost[];
    saved?: readonly SavedPost[];
    scan?: ScanRecord;
  } = { creatorId: value.creatorId, at: value.at };
  if (value.catalog !== undefined) {
    const catalog = decodeArray(value.catalog, decodeCatalogPost);
    if (catalog === null) return null;
    update.catalog = catalog;
  }
  if (value.saved !== undefined) {
    const saved = decodeArray(value.saved, decodeSavedPost);
    if (saved === null) return null;
    update.saved = saved;
  }
  if (value.scan !== undefined) {
    const scan = decodeScanRecord(value.scan);
    if (scan === null) return null;
    update.scan = scan;
  }
  return update;
}

/**
 * 受け取ったメッセージを履歴の書き込み要求として復号する。読めなければ null。
 *
 * `creatorId` を欠いた `historyRemove` をそのまま通すと `fbdlHistory:undefined` を消しにいく
 * (`undefined` という creatorId の履歴を実際に消しうる)。
 */
export function decodeHistoryMessage(message: unknown): HistoryMessage | null {
  if (!isRecord(message)) return null;
  if (message.type === 'historyRemove') {
    return typeof message.creatorId === 'string' && message.creatorId !== ''
      ? { type: 'historyRemove', creatorId: message.creatorId }
      : null;
  }
  if (message.type !== 'historyApply') return null;
  const update = decodeCreatorHistoryUpdate(message.update);
  return update === null ? null : { type: 'historyApply', update };
}
