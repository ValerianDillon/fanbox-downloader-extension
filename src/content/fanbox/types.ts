/**
 * プランAPIの型
 * @see https://api.fanbox.cc/plan.listCreator?creatorId=${creatorId}
 */
export type Plans = {
  body?: {
    id: string;
    title: string;
    fee: number;
    description: string;
    coverImageUrl: string;
  }[];
};

/**
 * タグAPIの型
 * @see https://api.fanbox.cc/tag.getFeatured?creatorId=${creatorId}
 */
export type Tags = {
  body?: {
    tag: string;
    count: number;
    coverImageUrl: string;
  }[];
};

/**
 * 投稿情報の型
 * @see https://api.fanbox.cc/post.listCreator?creatorId=${creatorId}
 * @see https://api.fanbox.cc/post.info?postId=${postId}
 */
export type PostInfo = {
  title: string;
  feeRequired: number;
  id: string;
  creatorId: string;
  coverImageUrl: string | null;
  excerpt: string;
  isRestricted: boolean;
  tags: string[];
  publishedDatetime: string;
  updatedDatetime: string;
  likeCount: number;
  commentCount: number;
} & (
  | {
      type: 'image';
      body: { text: string; images: ImageInfo[] };
    }
  | {
      type: 'file';
      body: { text: string; files: FileInfo[] };
    }
  | {
      type: 'article';
      body: {
        imageMap: Record<string, ImageInfo>;
        fileMap: Record<string, FileInfo>;
        embedMap: Record<string, EmbedInfo>;
        urlEmbedMap: Record<string, UrlEmbedInfo>;
        blocks: Block[];
      };
    }
  | {
      type: 'text';
      body: { text: string };
    }
  | {
      type: 'unknown';
      body: unknown;
    }
);

export type ImageInfo = { originalUrl: string; extension: string };
export type FileInfo = { url: string; name: string; extension: string };
export type EmbedInfo = unknown;
export type UrlEmbedInfo = { id: string } & (
  | { type: 'default'; url: string; host: string }
  | { type: 'html'; html: string }
  | { type: 'html.card'; html: string }
  | {
      type: 'fanbox.post';
      postInfo: { id: string; title: string; creatorId: string; coverImageUrl?: string };
    }
  | { type: 'unknown'; [key: string]: unknown }
);

export type ImageBlock = { type: 'image'; imageId: string };
export type FileBlock = { type: 'file'; fileId: string };
export type TextBlock = { type: 'p' | 'header'; text: string };
export type EmbedBlock = { type: 'embed'; embedId: string };
export type UrlEmbedBlock = { type: 'url_embed'; urlEmbedId: string };
export type UnknownBlock = { type: 'unknown' };
export type Block = ImageBlock | FileBlock | TextBlock | EmbedBlock | UrlEmbedBlock | UnknownBlock;
