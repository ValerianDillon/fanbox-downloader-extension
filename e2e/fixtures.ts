/**
 * smoke test 用の FANBOX API レスポンス fixture。
 *
 * 形状は node_modules/download-helper/fanbox-collector.ts の Plans / Tags / PaginatedPosts /
 * PostList / PostListItem / PostInfoResponse 型と src/content/fanbox/api.ts のアンラップ処理
 * (配列は `body` 直下ではなく `body.<キー>` に入る) に厳密に合わせている。
 *
 * 投稿構成 (どちらも一覧に本文が載らないため post.info への追加リクエストが走る):
 * - 投稿A (id=1001, image type): 無料投稿
 * - 投稿B (id=1002, file type): 有料投稿
 *
 * カバー画像は cover 用に pximg.net (i.pximg.net)、投稿内ファイルは fanbox.cc 系
 * (downloads.fanbox.cc) にして、両方の host_permissions (`*://*.fanbox.cc/*` /
 * `*://*.pximg.net/*`) を経由するようにしている。
 */

export const CREATOR_ID = 'testcreator';
export const CREATOR_PAGE_URL = 'https://testcreator.fanbox.cc/';

export const PLANS_URL = `https://api.fanbox.cc/plan.listCreator?creatorId=${CREATOR_ID}`;
export const TAGS_URL = `https://api.fanbox.cc/tag.getFeatured?creatorId=${CREATOR_ID}`;
export const PAGINATE_URL = `https://api.fanbox.cc/post.paginateCreator?creatorId=${CREATOR_ID}`;
export const LIST_PAGE_URL = `https://api.fanbox.cc/post.listCreator?creatorId=${CREATOR_ID}&cursor=1`;
export const POST_INFO_URL_A = 'https://api.fanbox.cc/post.info?postId=1001';
export const POST_INFO_URL_B = 'https://api.fanbox.cc/post.info?postId=1002';

// 投稿A: image type、無料
const POST_A_COVER_URL = 'https://i.pximg.net/c/testcreator/cover-a.jpg';
const POST_A_IMAGE_URL = 'https://downloads.fanbox.cc/images/1001/image1.png';

const POST_A_COMMON = {
  id: '1001',
  title: 'リンゴ',
  feeRequired: 0,
  creatorId: CREATOR_ID,
  excerpt: '',
  isRestricted: false,
  tags: [],
  publishedDatetime: '2024-01-01T00:00:00+09:00',
  updatedDatetime: '2024-01-01T00:00:00+09:00',
  likeCount: 0,
  commentCount: 0,
};

// 投稿B: file type、有料
const POST_B_COVER_URL = 'https://i.pximg.net/c/testcreator/cover-b.png';
const POST_B_FILE_URL = 'https://downloads.fanbox.cc/files/1002/document.pdf';

const POST_B_COMMON = {
  id: '1002',
  title: 'バナナ',
  feeRequired: 500,
  creatorId: CREATOR_ID,
  excerpt: '',
  isRestricted: false,
  tags: ['限定'],
  publishedDatetime: '2024-02-02T00:00:00+09:00',
  updatedDatetime: '2024-02-02T00:00:00+09:00',
  likeCount: 0,
  commentCount: 0,
};

// listCreator 一覧レスポンスに載る要素 (type / body を持たず、カバー画像は cover.url)
export const POST_A_STUB = { ...POST_A_COMMON, cover: { type: 'cover_image', url: POST_A_COVER_URL } };
export const POST_B_STUB = { ...POST_B_COMMON, cover: { type: 'cover_image', url: POST_B_COVER_URL } };

// post.info のレスポンスに載る投稿 (type / body / coverImageUrl を持つ)
export const POST_A_FULL = {
  ...POST_A_COMMON,
  coverImageUrl: POST_A_COVER_URL,
  type: 'image',
  body: {
    text: 'テキストA',
    images: [{ originalUrl: POST_A_IMAGE_URL, extension: 'png' }],
  },
};

export const POST_B_FULL = {
  ...POST_B_COMMON,
  coverImageUrl: POST_B_COVER_URL,
  type: 'file',
  body: {
    text: 'テキストB',
    files: [{ url: POST_B_FILE_URL, name: '資料', extension: 'pdf' }],
  },
};

export const PLANS_RESPONSE = { body: { plans: [] } };
export const TAGS_RESPONSE = { body: { featuredTags: [] } };
export const PAGINATE_RESPONSE = { body: { pageUrls: [LIST_PAGE_URL] } };
export const LIST_PAGE_RESPONSE = { body: { posts: [POST_A_STUB, POST_B_STUB] } };
export const POST_INFO_RESPONSE_A = { body: { post: POST_A_FULL } };
export const POST_INFO_RESPONSE_B = { body: { post: POST_B_FULL } };

/**
 * ダミーのファイルバイナリ。実体の形式は問わない (ZIP へはそのまま格納されるだけで、
 * download-helper 側でデコードされることはない) が、URL ごとに異なる内容にして
 * 取り違えがあれば CRC ミスマッチ等で顕在化するようにしている。
 */
export const FILE_BODIES: Record<string, { contentType: string; body: string }> = {
  [POST_A_COVER_URL]: { contentType: 'image/jpeg', body: 'FAKE-JPEG-COVER-A' },
  [POST_A_IMAGE_URL]: { contentType: 'image/png', body: 'FAKE-PNG-IMAGE-A' },
  [POST_B_COVER_URL]: { contentType: 'image/png', body: 'FAKE-PNG-COVER-B' },
  [POST_B_FILE_URL]: { contentType: 'application/pdf', body: 'FAKE-PDF-FILE-B' },
};

/** fetchFile が要求するはずの URL 集合 (cover 2 件 + ファイル 2 件) */
export const EXPECTED_FETCHED_URLS = [POST_A_COVER_URL, POST_A_IMAGE_URL, POST_B_COVER_URL, POST_B_FILE_URL];

/**
 * 期待される ZIP エントリ名一覧。
 *
 * download-helper.ts の downloadZip / DownloadObject.stringify (toJsonObjBy) から手で導出した固定値。
 * - encodedId = utils.encodeFileName('testcreator') = 'testcreator' (エスケープ対象文字なし)
 * - 各投稿の encodedName = utils.encodeFileName(title) (同名衝突なしなので getFileName はそのまま名前を返す)
 * - cover のエントリ名は 'cover' + '.' + (coverImageUrl の拡張子)
 * - image type の投稿は addFile(postName, ext, url) で呼ばれるため、ファイル名は投稿タイトルベースになる
 * - file type の投稿は addFile(file.name, file.extension, file.url) で呼ばれるため、ファイル名は FileInfo.name ベースになる
 */
export const EXPECTED_ZIP_ENTRIES = [
  'testcreator/index.html',
  'testcreator/リンゴ/info.json',
  'testcreator/リンゴ/index.html',
  'testcreator/リンゴ/cover.jpg',
  'testcreator/リンゴ/リンゴ.png',
  'testcreator/バナナ/info.json',
  'testcreator/バナナ/index.html',
  'testcreator/バナナ/cover.png',
  'testcreator/バナナ/資料.pdf',
].sort();
