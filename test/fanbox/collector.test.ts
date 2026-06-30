import { describe, expect, test } from 'bun:test';
import {
  addByPostInfo,
  convertEmbedMap,
  convertFileMap,
  convertImageMap,
  convertUrlEmbedMap,
} from '../../src/content/fanbox/collector';
import { DownloadManage } from '../../src/content/fanbox/download-manage';
import type { Block, EmbedInfo, FileInfo, ImageInfo, PostInfo, UrlEmbedInfo } from '../../src/content/fanbox/types';

describe('convertImageMap', () => {
  test('blocks 順にソートされる', () => {
    const imageMap: Record<string, ImageInfo> = {
      img1: { originalUrl: 'url1', extension: 'jpg' },
      img2: { originalUrl: 'url2', extension: 'png' },
      img3: { originalUrl: 'url3', extension: 'gif' },
    };
    const blocks: Block[] = [
      { type: 'image', imageId: 'img3' },
      { type: 'image', imageId: 'img1' },
      { type: 'image', imageId: 'img2' },
    ];
    const result = convertImageMap(imageMap, blocks);
    expect(result).toEqual([
      { originalUrl: 'url3', extension: 'gif' },
      { originalUrl: 'url1', extension: 'jpg' },
      { originalUrl: 'url2', extension: 'png' },
    ]);
  });

  test('blocks に存在しないキーは末尾に配置される (H-1 回帰テスト)', () => {
    const imageMap: Record<string, ImageInfo> = {
      img1: { originalUrl: 'url1', extension: 'jpg' },
      imgX: { originalUrl: 'urlX', extension: 'webp' },
      img2: { originalUrl: 'url2', extension: 'png' },
    };
    const blocks: Block[] = [
      { type: 'image', imageId: 'img2' },
      { type: 'image', imageId: 'img1' },
    ];
    const result = convertImageMap(imageMap, blocks);
    expect(result[0]).toEqual({ originalUrl: 'url2', extension: 'png' });
    expect(result[1]).toEqual({ originalUrl: 'url1', extension: 'jpg' });
    expect(result[2]).toEqual({ originalUrl: 'urlX', extension: 'webp' });
  });

  test('空の imageMap → 空配列', () => {
    const result = convertImageMap({}, [{ type: 'image', imageId: 'img1' }]);
    expect(result).toEqual([]);
  });

  test('空の blocks → imageMap のキー順 (全て末尾扱い)', () => {
    const imageMap: Record<string, ImageInfo> = {
      img1: { originalUrl: 'url1', extension: 'jpg' },
      img2: { originalUrl: 'url2', extension: 'png' },
    };
    const result = convertImageMap(imageMap, []);
    expect(result).toHaveLength(2);
  });

  test('blocks に image 以外のブロックが混在 → 無視される', () => {
    const imageMap: Record<string, ImageInfo> = {
      img1: { originalUrl: 'url1', extension: 'jpg' },
    };
    const blocks: Block[] = [
      { type: 'p', text: 'text' },
      { type: 'image', imageId: 'img1' },
      { type: 'file', fileId: 'file1' },
    ];
    const result = convertImageMap(imageMap, blocks);
    expect(result).toEqual([{ originalUrl: 'url1', extension: 'jpg' }]);
  });
});

describe('convertFileMap', () => {
  test('blocks 順にソートされる', () => {
    const fileMap: Record<string, FileInfo> = {
      f1: { url: 'url1', name: 'a', extension: 'txt' },
      f2: { url: 'url2', name: 'b', extension: 'pdf' },
    };
    const blocks: Block[] = [
      { type: 'file', fileId: 'f2' },
      { type: 'file', fileId: 'f1' },
    ];
    const result = convertFileMap(fileMap, blocks);
    expect(result[0].name).toBe('b');
    expect(result[1].name).toBe('a');
  });

  test('blocks に存在しないキーは末尾に配置される (H-1 回帰テスト)', () => {
    const fileMap: Record<string, FileInfo> = {
      f1: { url: 'url1', name: 'a', extension: 'txt' },
      fX: { url: 'urlX', name: 'x', extension: 'bin' },
    };
    const blocks: Block[] = [{ type: 'file', fileId: 'f1' }];
    const result = convertFileMap(fileMap, blocks);
    expect(result[0].name).toBe('a');
    expect(result[1].name).toBe('x');
  });
});

describe('convertEmbedMap', () => {
  test('blocks 順にソートされる', () => {
    const embedMap: Record<string, EmbedInfo> = {
      e1: { id: '1' },
      e2: { id: '2' },
    };
    const blocks: Block[] = [
      { type: 'embed', embedId: 'e2' },
      { type: 'embed', embedId: 'e1' },
    ];
    const result = convertEmbedMap(embedMap, blocks);
    expect(result[0]).toEqual({ id: '2' });
    expect(result[1]).toEqual({ id: '1' });
  });

  test('blocks に存在しないキーは末尾に配置される', () => {
    const embedMap: Record<string, EmbedInfo> = {
      e1: { id: '1' },
      eX: { id: 'X' },
    };
    const blocks: Block[] = [{ type: 'embed', embedId: 'e1' }];
    const result = convertEmbedMap(embedMap, blocks);
    expect(result[0]).toEqual({ id: '1' });
    expect(result[1]).toEqual({ id: 'X' });
  });
});

describe('convertUrlEmbedMap', () => {
  test('blocks 順にソートされる', () => {
    const urlEmbedMap: Record<string, UrlEmbedInfo> = {
      ue1: { id: 'ue1', type: 'default', url: 'http://a', host: 'a.com' },
      ue2: { id: 'ue2', type: 'default', url: 'http://b', host: 'b.com' },
    };
    const blocks: Block[] = [
      { type: 'url_embed', urlEmbedId: 'ue2' },
      { type: 'url_embed', urlEmbedId: 'ue1' },
    ];
    const result = convertUrlEmbedMap(urlEmbedMap, blocks);
    expect(result[0].id).toBe('ue2');
    expect(result[1].id).toBe('ue1');
  });

  test('blocks に存在しないキーは末尾に配置される', () => {
    const urlEmbedMap: Record<string, UrlEmbedInfo> = {
      ue1: { id: 'ue1', type: 'default', url: 'http://a', host: 'a.com' },
      ueX: { id: 'ueX', type: 'default', url: 'http://x', host: 'x.com' },
    };
    const blocks: Block[] = [{ type: 'url_embed', urlEmbedId: 'ue1' }];
    const result = convertUrlEmbedMap(urlEmbedMap, blocks);
    expect(result[0].id).toBe('ue1');
    expect(result[1].id).toBe('ueX');
  });
});

describe('addByPostInfo - publishedDatetime', () => {
  const createManage = () => new DownloadManage('testUser', new Map<number, string>());

  // text タイプは addFile を呼ばず、coverImageUrl: null で header の画像分岐も回避できる最小構成
  const baseTextPost = (publishedDatetime: string): PostInfo => ({
    title: 'タイトル',
    feeRequired: 0,
    id: 'post-1',
    creatorId: 'creator',
    coverImageUrl: null,
    excerpt: '',
    isRestricted: false,
    tags: [],
    publishedDatetime,
    updatedDatetime: '2024-05-02T00:00:00Z',
    likeCount: 0,
    commentCount: 0,
    type: 'text',
    body: { text: 'hello' },
  });

  const firstPost = (m: DownloadManage) => JSON.parse(m.downloadObject.stringify()).posts[0];

  test('publishedDatetime が posts に含まれる', () => {
    const m = createManage();
    addByPostInfo(m, baseTextPost('2024-05-01T12:34:56Z'));
    expect(firstPost(m).publishedDatetime).toBe('2024-05-01T12:34:56Z');
  });

  test('空文字 publishedDatetime → setPublishedDatetime を呼ばず例外なし', () => {
    const m = createManage();
    expect(() => addByPostInfo(m, baseTextPost(''))).not.toThrow();
    expect(firstPost(m).publishedDatetime).toBeUndefined();
  });

  test('未定義 publishedDatetime でも例外なし', () => {
    const m = createManage();
    const bad = { ...baseTextPost('x'), publishedDatetime: undefined } as unknown as PostInfo;
    expect(() => addByPostInfo(m, bad)).not.toThrow();
    expect(firstPost(m).publishedDatetime).toBeUndefined();
  });

  test('非文字列 publishedDatetime でも例外なし', () => {
    const m = createManage();
    const bad = { ...baseTextPost('x'), publishedDatetime: 12345 } as unknown as PostInfo;
    expect(() => addByPostInfo(m, bad)).not.toThrow();
    expect(firstPost(m).publishedDatetime).toBeUndefined();
  });
});
