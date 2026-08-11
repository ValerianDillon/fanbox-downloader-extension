const STORAGE_KEY = 'fbdlBackoffUntil';

/**
 * サーバー指定のバックオフ期限 (epoch ms) を保持する。
 *
 * MV3 の service worker はいつでも停止しうるため、SoT は chrome.storage.session に置く
 * (service worker が再起動しても storage は生き残る。ブラウザ終了時にはクリアされるが、
 * バックオフ期限はどのみち短命な情報なので問題にならない)。
 *
 * インスタンス内に持つメモリキャッシュは、同一ライフタイム内で何度も呼ばれる get() が
 * 毎回 storage を読みに行かずに済むようにするための補助にすぎない。書き込みは
 * 必ず storage にも反映する (キャッシュだけを更新して storage を欠かすと、直後に
 * service worker が停止したときに記録が失われる)。
 *
 * インスタンスをまたいでキャッシュは共有しない。service worker の再起動を再現したいときは、
 * 同じ chrome.storage.session を裏に持つ新しいインスタンスを作ればよい (キャッシュは
 * 空の状態から始まり、必ず storage から読み直す)。
 */
export class BackoffStore {
  private cache: number | undefined;

  async get(): Promise<number> {
    if (this.cache !== undefined) return this.cache;
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    this.cache = typeof value === 'number' ? value : 0;
    return this.cache;
  }

  /**
   * 候補の期限を記録し、記録後の値 (= 新しい現在値) を返す。
   *
   * 常に遠い方を採る: 複数のリクエストが並行して発行されていると、後から届いた応答の
   * 短い期限が、先に届いていた応答の長い期限を上書きしてしまいうるため。
   */
  async record(candidateUntil: number): Promise<number> {
    const current = await this.get();
    const next = Math.max(current, candidateUntil);
    if (next !== current) {
      this.cache = next;
      await chrome.storage.session.set({ [STORAGE_KEY]: next });
    }
    return next;
  }
}
