import type { PostSummary, Selection } from 'download-helper/download-helper';

/** review 画面の選択状態。DOM ではなくこの値を SoT にする。 */
export type ReviewSelection = {
  /** 利用者が選択した投稿。コンテンツ条件で一時的に無効になっても保持する。 */
  readonly postIds: Set<string>;
  /** 利用者が選択した拡張子。対象が 0 件になっても保持し、再び現れたら復元する。 */
  readonly extensions: Set<string>;
  /** カバー画像を含めたいか。対象が 0 件の間も保持する。 */
  includeCover: boolean;
  /** 投稿本文を含めたいか。 */
  includeBody: boolean;
};

export type ExtensionOption = {
  readonly extension: string;
  /** 現在選ばれている投稿に属する添付件数。 */
  readonly fileCount: number;
};

export type ContentAvailability = {
  readonly bodyCount: number;
  readonly coverCount: number;
  readonly extensions: ExtensionOption[];
};

export type SelectionCounts = {
  postCount: number;
  bodyCount: number;
  fileCount: number;
  coverCount: number;
  knownSizeBytes: number;
  unknownSizeCount: number;
};

export type PostDateField = 'published' | 'updated';

export type PostFilter = {
  readonly query: string;
  readonly dateField?: PostDateField;
  /** YYYY-MM-DD。指定日の 00:00 以降を含める。 */
  readonly from?: string;
  /** YYYY-MM-DD。指定日の終わりまでを含める。 */
  readonly to?: string;
};

/** 全コンテンツを選ぶ初期状態を作る。指定した投稿だけは既定で外す。 */
export function createInitialSelection(
  posts: readonly PostSummary[],
  initiallyExcludedPostIds: ReadonlySet<string> = new Set(),
): ReviewSelection {
  const postIds = new Set<string>();
  const extensions = new Set<string>();
  for (const post of posts) {
    if (!initiallyExcludedPostIds.has(post.postId)) postIds.add(post.postId);
    for (const file of post.files) extensions.add(file.extension);
  }
  return { postIds, extensions, includeCover: true, includeBody: true };
}

/** 全投稿に存在する拡張子を残し、件数だけを現在選ばれている投稿から集計する。 */
export function listExtensionOptions(
  posts: readonly PostSummary[],
  selectedPostIds: ReadonlySet<string> = new Set(posts.map((post) => post.postId)),
): ExtensionOption[] {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const file of post.files) {
      if (!counts.has(file.extension)) counts.set(file.extension, 0);
      if (selectedPostIds.has(post.postId)) counts.set(file.extension, (counts.get(file.extension) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([extension, fileCount]) => ({ extension, fileCount }))
    .sort((a, b) => {
      if (a.extension === '') return 1;
      if (b.extension === '') return -1;
      return a.extension < b.extension ? -1 : a.extension > b.extension ? 1 : 0;
    });
}

/** 現在選ばれている投稿に、各コンテンツが何件あるかを返す。 */
export function countContentAvailability(
  posts: readonly PostSummary[],
  selectedPostIds: ReadonlySet<string>,
): ContentAvailability {
  let bodyCount = 0;
  let coverCount = 0;
  for (const post of posts) {
    if (!selectedPostIds.has(post.postId)) continue;
    bodyCount++;
    if (post.cover) coverCount++;
  }
  return { bodyCount, coverCount, extensions: listExtensionOptions(posts, selectedPostIds) };
}

/** 投稿に、現在のコンテンツ条件で 1 件以上の保存対象があるかを返す。 */
export function hasSelectedContent(post: PostSummary, selection: ReviewSelection): boolean {
  if (selection.includeBody) return true;
  if (selection.includeCover && post.cover) return true;
  return post.files.some((file) => selection.extensions.has(file.extension));
}

/** 投稿選択とコンテンツ選択を掛け合わせた実効 postId を返す。 */
export function effectivePostIds(posts: readonly PostSummary[], selection: ReviewSelection): Set<string> {
  const ids = new Set<string>();
  for (const post of posts) {
    if (selection.postIds.has(post.postId) && hasSelectedContent(post, selection)) ids.add(post.postId);
  }
  return ids;
}

/** 現在の実効選択で ZIP に入る対象を数える。 */
export function countSelection(posts: readonly PostSummary[], selection: ReviewSelection): SelectionCounts {
  const counts: SelectionCounts = {
    postCount: 0,
    bodyCount: 0,
    fileCount: 0,
    coverCount: 0,
    knownSizeBytes: 0,
    unknownSizeCount: 0,
  };
  const addSize = (size: number | undefined) => {
    if (size === undefined) counts.unknownSizeCount++;
    else counts.knownSizeBytes += size;
  };
  for (const post of posts) {
    if (!selection.postIds.has(post.postId) || !hasSelectedContent(post, selection)) continue;
    counts.postCount++;
    if (selection.includeBody) counts.bodyCount++;
    for (const file of post.files) {
      if (!selection.extensions.has(file.extension)) continue;
      counts.fileCount++;
      addSize(file.metadata.size);
    }
    if (post.cover && selection.includeCover) {
      counts.coverCount++;
      addSize(post.cover.metadata.size);
    }
  }
  return counts;
}

function localDateKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 検索語と公開日・更新日の包含範囲で投稿を絞り込む。 */
export function filterPosts(posts: readonly PostSummary[], filter: string | PostFilter): PostSummary[] {
  const options: PostFilter = typeof filter === 'string' ? { query: filter } : filter;
  const normalized = options.query.trim().toLowerCase();
  const from = options.from?.trim() ?? '';
  const to = options.to?.trim() ?? '';
  const dateField = options.dateField ?? 'updated';
  return posts.filter((post) => {
    const matchesQuery =
      normalized === '' ||
      post.name.toLowerCase().includes(normalized) ||
      post.postId.toLowerCase().includes(normalized);
    if (!matchesQuery) return false;
    if (from === '' && to === '') return true;
    const key = localDateKey(dateField === 'updated' ? post.updatedDatetime : post.publishedDatetime);
    if (key === null) return false;
    return (from === '' || key >= from) && (to === '' || key <= to);
  });
}

/** UI の希望状態を共有層が受け取る実効 Selection に写す。 */
export function toSelection(posts: readonly PostSummary[], selection: ReviewSelection): Selection {
  const availability = countContentAvailability(posts, selection.postIds);
  return {
    postIds: effectivePostIds(posts, selection),
    extensions: new Set(
      availability.extensions
        .filter((option) => option.fileCount > 0 && selection.extensions.has(option.extension))
        .map((option) => option.extension),
    ),
    includeCover: selection.includeCover && availability.coverCount > 0,
    includeBody: selection.includeBody && availability.bodyCount > 0,
  };
}

const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

export function formatByteSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

export function describeSelectionCounts(counts: SelectionCounts): string {
  return `投稿 ${counts.postCount} 件、本文 ${counts.bodyCount} 件、添付 ${counts.fileCount} 件、カバー ${counts.coverCount} 件`;
}

export function describeSizeEstimate(counts: SelectionCounts): string {
  if (counts.fileCount === 0 && counts.coverCount === 0) {
    return counts.bodyCount > 0 ? 'メディアファイルなし (投稿本文と post.json を保存)' : '保存対象がありません';
  }
  if (counts.unknownSizeCount === 0) return `合計 ${formatByteSize(counts.knownSizeBytes)}`;
  if (counts.knownSizeBytes === 0)
    return `サイズ不明 ${counts.unknownSizeCount} 件 (画像とカバーは API にサイズ情報なし)`;
  return `既知分 ${formatByteSize(counts.knownSizeBytes)}、サイズ不明 ${counts.unknownSizeCount} 件 (合計は不明)`;
}

export function describeRenderedRange(matchedCount: number, renderedCount: number): string {
  return `${renderedCount} / ${matchedCount} 件を表示`;
}
