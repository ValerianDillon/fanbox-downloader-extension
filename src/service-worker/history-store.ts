import {
  type CreatorHistory,
  type CreatorHistoryUpdate,
  creatorIdFromHistoryKey,
  decodeCreatorHistory,
  estimateEntryBytes,
  HISTORY_BUDGET_BYTES,
  historyKeyFor,
  mergeCreatorHistory,
} from '../history-record';

/**
 * `chrome.storage.local` のうち、このストアが使う操作だけを表す。
 * ユニットテストから chrome のグローバルスタブなしに呼べるようにするための境界である。
 */
export type HistoryStorageArea = {
  /** `null` を渡すと全エントリを返す (`chrome.storage.local.get` の契約) */
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

/** 破棄の判断に使う、保存済み 1 エントリの情報 */
export type StoredEntry = {
  readonly creatorId: string;
  /** 復号できなかったレコードは 0。順序上いちばん先に捨てられる */
  readonly lastUsedAt: number;
  readonly bytes: number;
};

/**
 * 差分ダウンロードの履歴を保持する (Issue #56)。
 *
 * **書き込みは service worker に一本化する。** 拡張の service worker は 1 プロセスの単一スレッドなので、
 * ここで直列化すれば全タブの書き込みが直列になる。content script 側で直列化しても他タブとは競合する
 * (`media-attempt-log.ts` の `queue` が既にその限界を持つ)。
 * `navigator.locks` では解けない — Web Locks は origin で分割され、ページ origin の content script と
 * 拡張 origin の service worker でロックを共有できない。
 *
 * **使用量の索引は持たない。** 別のキーに合計と更新時刻を持たせると、索引と実体がずれたときに
 * 実体が容量計算から永久に外れる (索引が壊れた・版が上がった場合、次にその creator を
 * 更新するまで戻ってこない)。ずれた索引を根拠に「まだ余裕がある」と判断すると、実際の
 * `chrome.storage.local` の上限に当たって以後の書き込みが失敗し続ける。
 * 書き込みのたびに全エントリを読んで数える方が、状態が 1 つで済む。書き込みは収集 1 回につき
 * 数回しか起きないので、この読み直しは問題にならない。
 *
 * service worker はメモリ上のキューごといつでも停止する。`get` と `set` の間で停止すれば
 * その差分は失われるが、失われる方向は「履歴が欠ける → 再ダウンロード」で安全側である。
 * だからこそ 1 メッセージが単独で完結する (= 冪等な upsert である) 必要がある。
 */
export class HistoryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly area: HistoryStorageArea) {}

  /** creator の履歴を読む。無い・読めない場合は null */
  async read(creatorId: string): Promise<CreatorHistory | null> {
    return this.enqueue(() => this.readLocked(creatorId));
  }

  /** 差分を適用する。冪等なので、同じ差分を送り直しても結果は変わらない */
  async apply(update: CreatorHistoryUpdate): Promise<void> {
    return this.enqueue(() => this.applyLocked(update));
  }

  /** creator の履歴を消す (利用者の操作) */
  async remove(creatorId: string): Promise<void> {
    return this.enqueue(() => this.area.remove(historyKeyFor(creatorId)));
  }

  /** 直前の操作が終わるまで待ってから実行する (BackoffStore と同じパターン) */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // 失敗しても後続を止めない
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readLocked(creatorId: string): Promise<CreatorHistory | null> {
    const key = historyKeyFor(creatorId);
    const stored = await this.area.get(key);
    // キーから求めた creatorId を突き合わせる。キーと中身がずれたレコードを返すと、
    // 別の creator の保存実績を今の creator のものとして扱う
    return decodeCreatorHistory(stored[key], creatorId);
  }

  private async applyLocked(update: CreatorHistoryUpdate): Promise<void> {
    const all = await this.area.get(null);
    const key = historyKeyFor(update.creatorId);
    const merged = mergeCreatorHistory(decodeCreatorHistory(all[key], update.creatorId), update);
    const entries: StoredEntry[] = [];
    for (const [storedKey, value] of Object.entries(all)) {
      const creatorId = creatorIdFromHistoryKey(storedKey);
      if (creatorId === null || creatorId === update.creatorId) continue;
      const history = decodeCreatorHistory(value, creatorId);
      entries.push({ creatorId, lastUsedAt: history?.lastUsedAt ?? 0, bytes: estimateEntryBytes(storedKey, value) });
    }
    entries.push({
      creatorId: update.creatorId,
      lastUsedAt: merged.lastUsedAt,
      bytes: estimateEntryBytes(key, merged),
    });

    // **破棄と書き込みを 1 回の set にまとめる。** 先に remove してから set すると、その間に
    // service worker が停止したり set が失敗したりしたときに、更新対象と無関係な creator の
    // 履歴だけが消えて何も書かれない。捨てる側は null を書いて中身を空にする — 復号は null を
    // 「履歴が無い」として扱うので、これだけで破棄は成立し、容量も同じ set の中で解放される
    const { evicted } = evict(entries, update.creatorId);
    const items: Record<string, unknown> = { [key]: merged };
    for (const entry of evicted) items[historyKeyFor(entry.creatorId)] = null;
    await this.area.set(items);

    // 空にしたキー自体の後片付け。失敗しても状態は一貫している (null は履歴が無いのと同じ) ので、
    // ここでの失敗は呼び出し元へ伝えない
    if (evicted.length > 0) {
      try {
        await this.area.remove(evicted.map((entry) => historyKeyFor(entry.creatorId)));
      } catch (e) {
        console.warn('破棄した履歴のキーを削除できませんでした:', e);
      }
    }
  }
}

/**
 * 上限を超えていれば、最後に使った時刻の古い creator から丸ごと捨てる。
 *
 * **creator 単位でまとめて捨てる。** 投稿単位で部分的に捨てると「カタログが完全か」が誤って
 * true のまま残る経路ができる。creator ごと捨てれば履歴が無い状態に戻るだけなので、
 * 再ダウンロードになる方向にしか倒れない。
 *
 * 今まさに書こうとしている creator (`protected`) は捨てない。捨てるとその書き込みが無意味になる。
 * それ 1 件で上限を超える場合は、超えたまま書く (`chrome.storage.local` の実際の上限は
 * `HISTORY_BUDGET_BYTES` より大きく取ってあるので、そこで直ちに失敗はしない)。
 * @param entries 保存済みの全エントリ (`protected` の分は更新後の値であること)
 * @param protectedCreatorId 捨ててはいけない creator
 */
export function evict(
  entries: readonly StoredEntry[],
  protectedCreatorId: string,
): { kept: StoredEntry[]; evicted: StoredEntry[] } {
  const kept = [...entries];
  const evicted: StoredEntry[] = [];
  let total = kept.reduce((sum, entry) => sum + entry.bytes, 0);
  while (total > HISTORY_BUDGET_BYTES) {
    let oldest = -1;
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].creatorId === protectedCreatorId) continue;
      // 同じ時刻なら先に現れた方を捨てる。復号できなかったレコードは lastUsedAt が 0 なので
      // いちばん先に捨てられる (読めない以上、残しても容量を占めるだけである)
      if (oldest === -1 || kept[i].lastUsedAt < kept[oldest].lastUsedAt) oldest = i;
    }
    if (oldest === -1) break;
    total -= kept[oldest].bytes;
    evicted.push(kept[oldest]);
    kept.splice(oldest, 1);
  }
  return { kept, evicted };
}
