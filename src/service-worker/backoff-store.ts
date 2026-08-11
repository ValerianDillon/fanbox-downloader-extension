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
 *
 * get() / record() はいずれも内部の直列化キューを経由する。record() は「現在値を読む →
 * 遠い方を計算する → 書き込む」という read-modify-write なので、直列化しないと複数の 429 が
 * ほぼ同時に届いたときに両方が同じ現在値を読み、後から書き込んだ方が先に書き込んだ方を
 * (本来遠いはずの期限ごと) 上書きしてしまう。get() も同じキューに載せているのは、
 * 直列化されていない get() が record() の書き込み途中の状態を素通りしてしまわないようにするため。
 */
export class BackoffStore {
  private cache: number | undefined;
  /** get() / record() を順番に処理するための待ち行列。ApiSession.serialize() と同じパターン */
  private queue: Promise<unknown> = Promise.resolve();

  async get(): Promise<number> {
    return this.enqueue(() => this.getLocked());
  }

  /**
   * 候補の期限を記録し、記録後の値 (= 新しい現在値) を返す。
   *
   * 常に遠い方を採る: 複数のリクエストが並行して発行されていると、後から届いた応答の
   * 短い期限が、先に届いていた応答の長い期限を上書きしてしまいうるため。
   */
  async record(candidateUntil: number): Promise<number> {
    return this.enqueue(() => this.recordLocked(candidateUntil));
  }

  /** 直前の get() / record() が終わるまで待ってから実行する */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // 失敗しても後続を止めない
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async getLocked(): Promise<number> {
    if (this.cache !== undefined) return this.cache;
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    this.cache = typeof value === 'number' ? value : 0;
    return this.cache;
  }

  private async recordLocked(candidateUntil: number): Promise<number> {
    const current = await this.getLocked();
    const next = Math.max(current, candidateUntil);
    if (next !== current) {
      // storage への書き込みが成功する前にキャッシュを進めない。先にキャッシュだけ進めると、
      // set() が失敗したときにこのインスタンスは以後「記録済み」と誤答してしまう
      // (SoT は storage という契約に反する) うえ、service worker が直後に停止すると
      // 記録がどこにも残らない。
      await chrome.storage.session.set({ [STORAGE_KEY]: next });
      this.cache = next;
    }
    return next;
  }
}
