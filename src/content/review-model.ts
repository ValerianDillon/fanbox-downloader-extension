import type { PostSummary, Selection } from 'download-helper/download-helper';

/**
 * review 画面 (収集後の選択) の状態と集計。DOM を触らない純粋な部分だけをここに置く。
 *
 * 選択の意味論そのもの (投稿 × 拡張子 × カバーの積) は共有層の `Selection` が持ち、
 * 導出は `DownloadObject.project()` が行う。このモジュールが担うのは、UI が保持する
 * 可変の選択状態と、確定前に表示する件数・サイズの集計である。
 */

/**
 * 投稿リストを一度に描画する上限。
 *
 * 選択は postId の集合に対して適用するので、描画されていない投稿も選択・解除の対象になる。
 * したがってこの上限は描画コストだけを抑えるものであって、操作の対象範囲を狭めない。
 */
export const POST_LIST_RENDER_LIMIT = 200;

/**
 * review 画面が保持する選択状態。これが選択の SoT であり、DOM のチェック状態ではない。
 *
 * 検索や再描画でチェックボックスの要素は入れ替わるため、DOM を SoT にすると
 * 絞り込みの操作だけで選択が変わってしまう。
 */
export type ReviewSelection = {
  /** 選択された投稿の postId */
  readonly postIds: Set<string>;
  /** 選択された拡張子。`PostSummary.files[].extension` と同じ正規化済みの形 */
  readonly extensions: Set<string>;
  /** カバー画像を含めるか */
  includeCover: boolean;
};

/** 拡張子の選択肢 1 件 */
export type ExtensionOption = {
  /** 正規化済みの拡張子。拡張子が無いアセットは空文字列になる */
  readonly extension: string;
  /** この拡張子を持つ添付の総数。選択の有無に関わらない、収集できた全投稿での件数 */
  readonly fileCount: number;
};

/**
 * 現在の選択で ZIP に入る対象の集計。
 *
 * サイズは合計を断定しない。`size` は file 系のアセットにしか無く (実測 2026-08-22)、
 * image 系とカバーには無いため、既知分の合計と不明な件数を分けて持つ。
 */
export type SelectionCounts = {
  /** 選択された投稿数 */
  postCount: number;
  /** 選択された投稿に属し、拡張子の選択にも一致した添付の数 */
  fileCount: number;
  /** 選択された投稿のうち、カバーを持ち `includeCover` で含まれるものの数 */
  coverCount: number;
  /** 上の添付・カバーのうち、サイズが分かっているものの合計バイト数 */
  knownSizeBytes: number;
  /** 上の添付・カバーのうち、サイズが分からないものの件数 */
  unknownSizeCount: number;
};

/** 収集できた全投稿・全拡張子・カバーありを選んだ初期状態を作る */
export function createInitialSelection(posts: readonly PostSummary[]): ReviewSelection {
  const postIds = new Set<string>();
  const extensions = new Set<string>();
  for (const post of posts) {
    postIds.add(post.postId);
    for (const file of post.files) {
      extensions.add(file.extension);
    }
  }
  return { postIds, extensions, includeCover: true };
}

/**
 * 拡張子の選択肢を、拡張子ごとの添付件数付きで返す。
 *
 * 拡張子が無いアセット (空文字列) は末尾に置く。他の拡張子と同じ辞書順に混ぜると
 * 先頭に来て、選択肢の並びの起点が「拡張子なし」になる。
 * @param posts 収集できた投稿
 */
export function listExtensionOptions(posts: readonly PostSummary[]): ExtensionOption[] {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const file of post.files) {
      counts.set(file.extension, (counts.get(file.extension) ?? 0) + 1);
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

/**
 * 現在の選択で ZIP に入る対象を数える。
 *
 * 拡張子の選択はカバーには適用しない (カバーは投稿の付随物であって添付の一種ではない)。
 * 共有層の projection と同じ意味論にしておかないと、確定前の表示と ZIP の中身がずれる。
 * @param posts 収集できた投稿
 * @param selection 現在の選択状態
 */
export function countSelection(posts: readonly PostSummary[], selection: ReviewSelection): SelectionCounts {
  const counts: SelectionCounts = {
    postCount: 0,
    fileCount: 0,
    coverCount: 0,
    knownSizeBytes: 0,
    unknownSizeCount: 0,
  };
  const addSize = (size: number | undefined) => {
    if (size === undefined) {
      counts.unknownSizeCount++;
      return;
    }
    counts.knownSizeBytes += size;
  };
  for (const post of posts) {
    if (!selection.postIds.has(post.postId)) continue;
    counts.postCount++;
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

/**
 * 検索語で投稿を絞り込む。空の検索語は全件に一致する。
 *
 * 投稿タイトルと postId のどちらかに含まれていれば一致とする。同名の投稿が並ぶクリエイターでは
 * タイトルだけでは目的の投稿を指せないため、URL から分かる postId でも引けるようにする。
 * @param posts 収集できた投稿
 * @param query 検索語
 */
export function filterPosts(posts: readonly PostSummary[], query: string): PostSummary[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') return [...posts];
  return posts.filter(
    (post) => post.name.toLowerCase().includes(normalized) || post.postId.toLowerCase().includes(normalized),
  );
}

/**
 * UI の選択状態を共有層の `Selection` に写す。
 *
 * 集合を複製する。`project()` に渡した後も UI 側の集合は操作され続けるので、同じ参照を渡すと
 * 確定後の操作が既に導出済みの対象を書き換えうる。
 * @param selection 現在の選択状態
 */
export function toSelection(selection: ReviewSelection): Selection {
  return {
    postIds: new Set(selection.postIds),
    extensions: new Set(selection.extensions),
    includeCover: selection.includeCover,
  };
}

const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/**
 * バイト数を人間が読める単位にする。2 進接頭辞を使うのは、この拡張の他の箇所
 * (分割転送の chunk サイズなど) と単位の意味を揃えるため。
 * @param bytes バイト数
 */
export function formatByteSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // B は小数を出しても意味が無い。それ以外は 1 桁だけ出して桁を追えるようにする
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/** 選択された対象の件数を 1 行で表す */
export function describeSelectionCounts(counts: SelectionCounts): string {
  return `投稿 ${counts.postCount} 件、添付 ${counts.fileCount} 件、カバー ${counts.coverCount} 件`;
}

/**
 * 選択された対象のサイズを 1 行で表す。
 *
 * **合計を断定しない。** `size` を持たないアセットがある限り、既知分の合計は下限でしかない。
 * @param counts 集計結果
 */
export function describeSizeEstimate(counts: SelectionCounts): string {
  if (counts.fileCount === 0 && counts.coverCount === 0) {
    return '取得するファイルはありません (HTML と投稿情報のみ)';
  }
  if (counts.unknownSizeCount === 0) {
    return `合計 ${formatByteSize(counts.knownSizeBytes)}`;
  }
  if (counts.knownSizeBytes === 0) {
    return `サイズ不明 ${counts.unknownSizeCount} 件 (合計は不明)`;
  }
  return `既知分 ${formatByteSize(counts.knownSizeBytes)}、サイズ不明 ${counts.unknownSizeCount} 件 (合計は不明)`;
}

/** 投稿リストの描画件数と一致件数を 1 行で表す */
export function describeRenderedRange(matchedCount: number, renderedCount: number): string {
  return `${renderedCount} / ${matchedCount} 件を表示`;
}
