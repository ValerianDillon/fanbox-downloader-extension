import {
  type CreatorHistory,
  type CreatorHistoryUpdate,
  decodeCreatorHistory,
  type HistoryMessage,
  type HistoryResponse,
  historyKeyFor,
} from '../history-record';

/**
 * content script から差分ダウンロードの履歴を読み書きする (Issue #56)。
 *
 * **読みは `chrome.storage.local` を直接引き、書きは service worker へ送る。**
 * 読みまで往復にすると収集の入口で service worker の起動待ちが入る一方、書きは
 * タブをまたぐ read-modify-write なので単一スレッドの直列キューで守る必要がある
 * (理由は `service-worker/history-store.ts` のコメント)。
 *
 * content script から Web Storage / IndexedDB を使うと FANBOX ページ側の origin になるため
 * 使わない。`chrome.storage.local` は拡張の領域である。
 */

/**
 * creator の履歴を読む。
 *
 * **読めなければ null に倒す。** 版が違う・壊れている・storage が無い、のいずれでも「履歴が無い」と
 * 同じ扱いにする。部分的に信じると、実際には保存していない対象を「前回保存済み」として飛ばしうる。
 * 無いものとして扱えば再ダウンロードになるだけである。
 */
export async function readCreatorHistory(creatorId: string): Promise<CreatorHistory | null> {
  const local = typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;
  if (!local) return null;
  const key = historyKeyFor(creatorId);
  try {
    const stored = await local.get(key);
    // キーから求めた creatorId を突き合わせる。キーと中身がずれたレコードを返すと、
    // 別の creator の保存実績を今の creator のものとして扱う
    return decodeCreatorHistory(stored[key], creatorId);
  } catch (e) {
    console.warn('履歴の読み出しに失敗しました。履歴なしとして扱います:', e);
    return null;
  }
}

/**
 * 差分判定に使う履歴を service worker 経由で読む (Issue #56)。
 *
 * **設定画面の表示用の読み出し (`readCreatorHistory`) とは分ける。**
 * こちらは `historyRemove` と同じキューを通るので、**別のタブが削除している最中でも、
 * 要求が届いた順に直列化される**。storage を直接引くとこの順序が保証されず、削除より後に
 * 始めた収集が削除前の履歴で `post.info` を省きうる (確認文の「次回は全件を取得します」に反する)。
 *
 * 表示用まで往復にしないのは、パネルを開くたびに service worker の起動待ちが入るためである。
 * 表示が古くても実害は無い (省略の判断には使わない)。
 *
 * 読めなければ null に倒す。応答が想定外・service worker が失敗を返した・例外、のいずれでも
 * 「履歴が無い」と同じ扱いにする (再ダウンロードになるだけである)。
 */
export async function readCreatorHistoryForCollect(creatorId: string): Promise<CreatorHistory | null> {
  const response = await sendHistoryMessage({ type: 'historyRead', creatorId });
  if (!response.ok) {
    console.warn('履歴の読み出しに失敗しました。履歴なしとして扱います:', response.error);
    return null;
  }
  // service worker が復号した値でも、messaging を跨いだ後にもう一度確かめる。
  // 古い service worker が別の形を返す可能性があり、その形のまま差分判定に使わせない
  return decodeCreatorHistory(response.history, creatorId);
}

/**
 * 差分を service worker へ送って適用させる。
 *
 * 冪等な差分なので、応答を得られなかったときに送り直しても結果は変わらない。
 * ただしここでは自動で送り直さない — 失敗を利用者に見せる方が、黙って再送して結果を
 * 曖昧にするより実態に合う。
 */
export async function applyCreatorHistory(update: CreatorHistoryUpdate): Promise<HistoryResponse> {
  return sendHistoryMessage({ type: 'historyApply', update });
}

/** creator の履歴を消す (利用者の操作) */
export async function removeCreatorHistory(creatorId: string): Promise<HistoryResponse> {
  return sendHistoryMessage({ type: 'historyRemove', creatorId });
}

async function sendHistoryMessage(message: HistoryMessage): Promise<HistoryResponse> {
  const runtime = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
  if (!runtime?.sendMessage) return { ok: false, error: 'chrome.runtime が利用できません' };
  try {
    const response: unknown = await runtime.sendMessage(message);
    // 応答の形が想定と違えば成功とは言えない。service worker が listener を持たない版に
    // 差し替わっている場合 (undefined が返る) をここで成功に丸めない
    if (typeof response !== 'object' || response === null) {
      return { ok: false, error: '履歴の更新に対する応答が想定外です' };
    }
    const { ok, error, history } = response as { ok?: unknown; error?: unknown; history?: unknown };
    // `history` は `historyRead` の応答にだけ入る。落とすと収集用の読み出しが常に
    // 「履歴なし」になり、差分判定が一度も成立しない
    if (ok === true) return { ok: true, history };
    // error も検証する。キャストで通すと、文字列でない値が呼び出し側の表示処理へ流れる
    return { ok: false, error: typeof error === 'string' ? error : '履歴の更新に対する応答が想定外です' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
