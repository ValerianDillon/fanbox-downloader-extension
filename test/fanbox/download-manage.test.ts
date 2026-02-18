import { describe, expect, test } from 'bun:test';
import { DownloadManage } from '../../src/content/fanbox/download-manage';

describe('DownloadManage', () => {
  const createManage = () => new DownloadManage('testUser', new Map([[100, '100円プラン']]));

  describe('addFee', () => {
    test('重複排除', () => {
      const m = createManage();
      m.addFee(100);
      m.addFee(100);
      m.addFee(200);
      m.applyTags();
    });

    test('複数の fee を追加', () => {
      const m = createManage();
      m.addFee(0);
      m.addFee(500);
      expect(m.getTagByFee(0)).toBe('無料プラン');
      expect(m.getTagByFee(500)).toBe('500円プラン');
    });
  });

  describe('addTags', () => {
    test('重複排除', () => {
      const m = createManage();
      m.addTags('tag1', 'tag2');
      m.addTags('tag2', 'tag3');
      m.applyTags();
    });

    test('複数タグを一度に追加', () => {
      const m = createManage();
      m.addTags('a', 'b', 'c');
      m.applyTags();
    });
  });

  describe('getTagByFee', () => {
    test('feeMap に存在する fee → マップの値', () => {
      const m = createManage();
      expect(m.getTagByFee(100)).toBe('100円プラン');
    });

    test('feeMap に存在しない正の fee → "N円プラン"', () => {
      const m = createManage();
      expect(m.getTagByFee(500)).toBe('500円プラン');
    });

    test('fee が 0 → "無料プラン"', () => {
      const m = createManage();
      expect(m.getTagByFee(0)).toBe('無料プラン');
    });
  });

  describe('limit', () => {
    test('isLimitAvailable=false → isLimitValid は常に true', () => {
      const m = createManage();
      expect(m.isLimitValid()).toBe(true);
    });

    test('isLimitAvailable=true, limit>0 → isLimitValid は true', () => {
      const m = createManage();
      m.setLimitAvailable(true);
      m.setLimit(3);
      expect(m.isLimitValid()).toBe(true);
    });

    test('decrementLimit → limit 減少', () => {
      const m = createManage();
      m.setLimitAvailable(true);
      m.setLimit(2);
      expect(m.isLimitValid()).toBe(true);
      m.decrementLimit();
      expect(m.isLimitValid()).toBe(true);
      m.decrementLimit();
      expect(m.isLimitValid()).toBe(false);
    });

    test('limit が 0 になったら isLimitValid は false', () => {
      const m = createManage();
      m.setLimitAvailable(true);
      m.setLimit(1);
      m.decrementLimit();
      expect(m.isLimitValid()).toBe(false);
    });
  });

  describe('applyTags', () => {
    test('fees をソートして feeMap のタグ名に変換、残りのタグを追加', () => {
      const m = new DownloadManage(
        'testUser',
        new Map([
          [100, 'ファン'],
          [500, 'サポーター'],
        ]),
      );
      m.addFee(500);
      m.addFee(100);
      m.addTags('タグA', 'タグB');
      m.applyTags();
      const json = JSON.parse(m.downloadObject.stringify());
      expect(json.tags).toEqual(['ファン', 'サポーター', 'タグA', 'タグB']);
    });
  });
});
