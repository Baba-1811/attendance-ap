/**
 * app.js
 * 出退勤打刻アプリのメインロジック
 *
 * 処理の流れ:
 *   1. ページ読み込み時に localStorage から当日の打刻状態を復元する
 *   2. 現在時刻を 1 秒ごとに更新する
 *   3. 出勤 / 退勤ボタンのクリックで GAS へ POST 通信する
 *   4. 課題完了報告フォームのバリデーションと送信を行う
 */

"use strict";

/* ============================================================
   0. 定数
   ============================================================ */

/**
 * GAS ウェブアプリの URL
 * デプロイ後に発行される URL をここに貼り付ける
 * 例: "https://script.google.com/macros/s/XXXX/exec"
 */
const GAS_URL = "https://script.google.com/macros/s/AKfycby0vl4KjbGTcDTmQBdw9i0xpLnNawgvKL1o2WU4fLYEGQQ6SGwQ4E_BDUCIWMgfGk8M/exec";

/**
 * 研修生 ID
 * GAS の研修生マスタシートの A列 (employeeId) と完全に一致させる必要がある。
 */
const EMPLOYEE_ID = "user01";

/**
 * fetch のタイムアウト時間 (ミリ秒)
 * GAS は起動に時間がかかる場合があるため 15 秒に設定する
 */
const FETCH_TIMEOUT_MS = 15000;

/**
 * トーストを表示する時間 (ミリ秒)
 */
const TOAST_DURATION_MS = 3000;

/**
 * localStorage のキー名
 * 他のサイトのデータと衝突しないようにアプリ名を prefix にする
 * 氏名・打刻状態をまとめて1つのキーで管理する（分けると不整合が起きる）
 */
const STORAGE_KEY = "attendance_app_state";

/* ============================================================
   1. DOM 要素の取得
   getElementById で要素を取得してまとめて管理する
   「js-」prefix の id は「JavaScript から操作する要素」の目印
   ============================================================ */
const elements = {
  // ヘッダー
  date:           document.getElementById("js-date"),
  // ステータスエリア
  clock:          document.getElementById("js-clock"),
  recordOut:      document.getElementById("js-record-out"),
  recordDuration: document.getElementById("js-record-duration"),
  clockOutTime:   document.getElementById("js-clock-out-time"),
  workDuration:   document.getElementById("js-work-duration"),
  // 氏名入力欄
  nameInput:      document.getElementById("js-name-input"),
  // 打刻ボタン
  btnClockIn:     document.getElementById("js-btn-clock-in"),
  btnClockOut:    document.getElementById("js-btn-clock-out"),
  // 課題完了報告フォーム
  // ※ HTML 側の id は js-task-input のままだが、内容はアプリ URL を入力する欄として使う
  appUrlInput:    document.getElementById("js-task-input"),
  charCount:      document.getElementById("js-char-count"),
  btnReport:      document.getElementById("js-btn-report"),
  // トースト
  toast:          document.getElementById("js-toast"),
  toastMessage:   document.getElementById("js-toast-message"),
};

/* ============================================================
   2. アプリの状態管理
   UI の状態を一箇所のオブジェクトで管理する
   状態が変わったら updateUI() を呼んで画面を再描画する
   ============================================================ */

/**
 * アプリの状態を保持するオブジェクト
 * @type {{
 *   clockIn:  string | null,  出勤時刻 (HH:MM) または null
 *   clockOut: string | null,  退勤時刻 (HH:MM) または null
 *   name:     string,         氏名 (入力欄と同期する)
 * }}
 */
let state = {
  clockIn:  null,
  clockOut: null,
  name:     "",
};

/* ============================================================
   3. localStorage の操作
   ページをリロードしても当日の打刻状態を復元するために使う
   ============================================================ */

/**
 * 今日の日付を "YYYY-MM-DD" 形式で返す
 * @returns {string}
 */
function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  // getMonth() は 0 始まりなので +1 する
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * state（氏名・打刻状態）を localStorage にまとめて保存する
 *
 * name / clockIn / clockOut をひとつのオブジェクトで保存することで、
 * 「氏名だけ消える」「打刻状態だけ残る」という不整合を防ぐ。
 * プライベートブラウジングでは例外が出るので try-catch で囲む
 */
function saveState() {
  try {
    const data = {
      date:     getTodayString(),
      name:     state.name,     // ← 氏名も一緒に保存する
      clockIn:  state.clockIn,
      clockOut: state.clockOut,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    // localStorage が使えない環境では何もしない (セッション中のみ状態を保持)
    console.warn("localStorage への保存に失敗しました:", e);
  }
}

/**
 * localStorage から state を読み込む
 *
 * 日付が今日と一致する場合: name / clockIn / clockOut をすべて復元する
 * 日付が変わっている場合 : 打刻状態（clockIn/clockOut）はリセットするが
 *                          氏名だけは引き継ぐ（毎朝また入力しなくて済むため）
 */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return; // 保存データなし → 初期状態のまま

    const data = JSON.parse(raw);

    // 氏名は日付に関係なく引き継ぐ
    state.name = data.name ?? "";

    // 保存された日付と今日を比較し、違えば打刻状態はリセットする
    if (data.date !== getTodayString()) {
      localStorage.removeItem(STORAGE_KEY);
      return; // clockIn / clockOut は初期値 null のまま
    }

    // 今日のデータがあれば打刻状態も復元する
    state.clockIn  = data.clockIn  ?? null;
    state.clockOut = data.clockOut ?? null;
  } catch (e) {
    console.warn("localStorage の読み込みに失敗しました:", e);
  }
}

/* ============================================================
   4. UI の更新
   state の内容に合わせて DOM を書き換える関数をまとめる
   ============================================================ */

/**
 * ヘッダーの日付表示を更新する
 * 例: "2026年3月17日(火)"
 * ※ 全角括弧ではなく半角括弧 () を使う
 */
function renderDate() {
  const now  = new Date();
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  const y    = now.getFullYear();
  const m    = now.getMonth() + 1; // getMonth() は 0 始まりなので +1
  const d    = now.getDate();
  const day  = days[now.getDay()];
  elements.date.textContent = `${y}年${m}月${d}日(${day})`;
}

/**
 * 氏名入力欄を state.name の値で初期化する
 * ページ読み込み時に localStorage から復元した氏名を反映する
 */
function renderNameInput() {
  elements.nameInput.value = state.name;
}

/**
 * ステータスエリアの出勤・退勤・勤務時間表示を state に合わせて更新する
 */
function renderStatus() {
  // --- 退勤時刻の表示 ---
  if (state.clockOut) {
    elements.clockOutTime.textContent = state.clockOut;
    elements.recordOut.classList.remove("hidden");
  } else {
    elements.recordOut.classList.add("hidden");
  }

  // --- 勤務時間の表示 (出勤・退勤どちらも打刻済みのとき) ---
  if (state.clockIn && state.clockOut) {
    const minutes = calcWorkMinutes(state.clockIn, state.clockOut);
    const hours   = Math.floor(minutes / 60);
    const mins    = minutes % 60;
    elements.workDuration.textContent = `${hours}時間${mins}分`;
    elements.recordDuration.classList.remove("hidden");
  } else {
    elements.recordDuration.classList.add("hidden");
  }
}

/**
 * ボタンの有効/無効を state に合わせて切り替える
 * 氏名が空のときはすべての打刻ボタンを無効にする
 */
function renderButtons() {
  const hasName = state.name.trim() !== "";
  // 出勤ボタン: 氏名未入力 または 出勤打刻済みなら無効
  elements.btnClockIn.disabled  = !hasName || state.clockIn !== null;
  // 退勤ボタン: 氏名未入力 または 出勤前 または 退勤済みなら無効
  elements.btnClockOut.disabled = !hasName || state.clockIn === null || state.clockOut !== null;
}

/**
 * state の変化に合わせて画面全体を再描画するメイン関数
 * 状態が変わったら必ずこれを呼ぶ
 */
function updateUI() {
  renderStatus();
  renderButtons();
}

/* ============================================================
   5. 現在時刻のリアルタイム更新
   ============================================================ */

/**
 * 現在時刻を "HH:MM:SS" 形式で clock 要素に書き込む
 * setInterval で 1 秒ごとに呼ばれる
 */
function updateClock() {
  const now = new Date();
  const h   = String(now.getHours()).padStart(2, "0");
  const m   = String(now.getMinutes()).padStart(2, "0");
  const s   = String(now.getSeconds()).padStart(2, "0");
  elements.clock.textContent = `${h}:${m}:${s}`;
}

/* ============================================================
   6. トースト通知
   ============================================================ */

/** トーストの自動消去用タイマー ID。複数重なりを防ぐために保持する */
let toastTimerId = null;

/**
 * トースト通知を表示する
 * @param {string} message   表示するメッセージ
 * @param {"success"|"error"|"info"} type  通知の種類
 */
function showToast(message, type = "success") {
  // 前のタイマーが残っていたらキャンセルする
  if (toastTimerId) {
    clearTimeout(toastTimerId);
    toastTimerId = null;
  }

  const { toast, toastMessage } = elements;

  // テキストとスタイルを設定
  toastMessage.textContent = message;
  toast.className = "toast"; // クラスをリセット
  if (type === "error") toast.classList.add("toast--error");
  if (type === "info")  toast.classList.add("toast--info");

  // hidden を外して表示
  toast.classList.remove("hidden");

  // TOAST_DURATION_MS 後に hidden を付けてフェードアウト
  toastTimerId = setTimeout(() => {
    toast.classList.add("hidden");
    toastTimerId = null;
  }, TOAST_DURATION_MS);
}

/* ============================================================
   7. GAS との通信
   ============================================================ */

/**
 * タイムアウト付きで GAS へ POST リクエストを送る
 *
 * @param {Object} body  送信するデータ（JSON に変換して送る）
 * @returns {Promise<{status: string, message: string}>} GAS からのレスポンス
 * @throws {Error} 通信失敗またはタイムアウト時
 */
async function postToGAS(body) {
  // AbortController でタイムアウトを実装する
  // abort() を呼ぶと fetch が中断される
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(GAS_URL, {
      method:  "POST",
      // Content-Type: application/json はブラウザに CORS プリフライト (OPTIONS) を
      // 送らせてしまい、GAS が OPTIONS に対応していないため TypeError になる。
      // text/plain にすることで「単純リクエスト」として扱われ、プリフライトが発生しなくなる。
      // GAS 側の parseRequestBody は e.postData.contents を JSON.parse するので
      // Content-Type が text/plain でも問題なく受け取れる。
      headers: { "Content-Type": "text/plain" },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });

    // タイムアウトタイマーをキャンセル（正常に返ってきた場合）
    clearTimeout(timeoutId);

    // HTTP ステータスが 200 番台以外はエラーとして扱う
    if (!response.ok) {
      throw new Error(`サーバーエラーが発生しました（HTTP ${response.status}）`);
    }

    return await response.json();

  } catch (err) {
    clearTimeout(timeoutId);

    // AbortError はタイムアウトによる中断
    if (err.name === "AbortError") {
      throw new Error("タイムアウトしました。時間をおいて再度お試しください");
    }

    // fetch 自体が失敗 = ネットワーク接続なし
    if (err instanceof TypeError) {
      throw new Error("通信に失敗しました。ネットワークを確認してください");
    }

    // 上記以外のエラーはそのまま再スロー
    throw err;
  }
}

/* ============================================================
   8. 打刻ボタンのローディング状態管理
   ============================================================ */

/**
 * ボタンをローディング状態にする（スピナー表示・操作不可）
 * @param {HTMLButtonElement} btn
 */
function setButtonLoading(btn) {
  btn.disabled = true;
  btn.querySelector(".btn__spinner").classList.remove("hidden");
}

/**
 * ボタンのローディング状態を解除する
 * @param {HTMLButtonElement} btn
 */
function clearButtonLoading(btn) {
  btn.querySelector(".btn__spinner").classList.add("hidden");
  // disabled の解除は updateUI() が行うので、ここでは外さない
}

/* ============================================================
   9. 勤務時間の計算
   ============================================================ */

/**
 * 2 つの時刻文字列 (HH:MM) から勤務時間を分単位で返す
 * @param {string} clockIn   例: "09:00"
 * @param {string} clockOut  例: "18:00"
 * @returns {number}  勤務分数 (例: 540)
 */
function calcWorkMinutes(clockIn, clockOut) {
  const [inH,  inM]  = clockIn.split(":").map(Number);
  const [outH, outM] = clockOut.split(":").map(Number);
  return (outH * 60 + outM) - (inH * 60 + inM);
}

/**
 * 現在時刻を "HH:MM" 形式で返す
 * @returns {string}
 */
function getCurrentTimeHHMM() {
  const now = new Date();
  const h   = String(now.getHours()).padStart(2, "0");
  const m   = String(now.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * 現在時刻を ISO 8601 形式（タイムゾーン付き）で返す
 * GAS のリクエストボディに使う
 * 例: "2026-03-17T09:00:00+09:00"
 * @returns {string}
 */
function getCurrentTimestamp() {
  return new Date().toISOString().replace("Z", "+09:00");
  // ※ 実際には端末のタイムゾーンを考慮したほうが正確だが、
  //   日本国内利用前提でシンプルに JST 固定とする
}

/* ============================================================
   10. 出勤打刻
   ============================================================ */

/**
 * 出勤ボタンが押されたときの処理
 */
async function handleClockIn() {
  // 氏名の取得と空欄チェック（renderButtons でボタンを無効にしているが念のため二重チェック）
  const name = elements.nameInput.value.trim();
  if (!name) {
    showToast("氏名を入力してください", "error");
    return;
  }

  // 確認ダイアログ
  if (!window.confirm("出勤を打刻しますか？")) return;

  // ローディング開始（二重送信防止のため disabled + スピナー表示）
  setButtonLoading(elements.btnClockIn);

  try {
    // GAS へ送るデータを組み立てる
    const body = {
      action:     "clockIn",
      employeeId: EMPLOYEE_ID,
      name:       name,            // 氏名入力欄から取得
      timestamp:  getCurrentTimestamp(),
    };

    const result = await postToGAS(body);

    if (result.status === "ok") {
      // 成功: state を更新して UI を再描画
      state.clockIn = getCurrentTimeHHMM();
      saveState();
      updateUI();
      showToast(result.message, "success");
    } else {
      // GAS 側のビジネスロジックエラー (例: すでに打刻済み / 研修生マスタ不一致)
      showToast(result.message, "error");
    }

  } catch (err) {
    // 通信エラー・タイムアウト
    showToast(err.message, "error");
  } finally {
    // ローディング終了（finally で必ず実行される）
    clearButtonLoading(elements.btnClockIn);
    // ボタンの有効/無効は state を見て再設定
    renderButtons();
  }
}

/* ============================================================
   11. 退勤打刻
   ============================================================ */

/**
 * 退勤ボタンが押されたときの処理
 */
async function handleClockOut() {
  // 氏名の取得と空欄チェック
  const name = elements.nameInput.value.trim();
  if (!name) {
    showToast("氏名を入力してください", "error");
    return;
  }

  if (!window.confirm("退勤を打刻しますか？")) return;

  setButtonLoading(elements.btnClockOut);

  try {
    const body = {
      action:     "clockOut",
      employeeId: EMPLOYEE_ID,
      name:       name,            // 氏名入力欄から取得
      timestamp:  getCurrentTimestamp(),
    };

    const result = await postToGAS(body);

    if (result.status === "ok") {
      state.clockOut = getCurrentTimeHHMM();
      saveState();
      updateUI();
      showToast(result.message, "success");
    } else {
      showToast(result.message, "error");
    }

  } catch (err) {
    showToast(err.message, "error");
  } finally {
    clearButtonLoading(elements.btnClockOut);
    renderButtons();
  }
}

/* ============================================================
   12. 課題完了報告
   ============================================================ */

/**
 * 氏名入力欄に変化があったときの処理
 * state.name を更新し、localStorage に保存し、ボタン状態と画面を再評価する
 *
 * 【重要】氏名が変わったら打刻状態（clockIn/clockOut）をリセットする
 *
 * なぜリセットが必要か:
 *   state は { name, clockIn, clockOut } をまとめて1件保持する構造のため、
 *   「Aさんの出勤済み state」が残った状態で Bさんが名前を入力すると
 *   「Bさんの名前 + Aさんの打刻状態」という矛盾が生じ、両ボタンが disabled のまま
 *   新規出勤できなくなる。氏名が変わった時点で打刻状態を白紙に戻すことで
 *   この不整合を防ぐ。
 */
function handleNameInput() {
  const prevName = state.name;           // 変更前の氏名（比較に使う）
  const newName  = elements.nameInput.value;

  state.name = newName;

  // 氏名が変わった かつ 打刻状態が残っている場合はリセットする
  // （前の人の clockIn/clockOut を次の人に引き継がせない）
  if (newName.trim() !== prevName.trim() &&
      (state.clockIn !== null || state.clockOut !== null)) {
    state.clockIn  = null;
    state.clockOut = null;
  }

  saveState(); // name / clockIn / clockOut をまとめて保存

  // 打刻ボタン + ステータス表示を再描画（clockIn/clockOut がリセットされた場合に退勤表示も消える）
  updateUI();

  // 送信ボタンも「氏名 AND URL 入力あり」でのみ有効にする
  const hasUrl  = elements.appUrlInput.value.trim().length > 0;
  const hasName = state.name.trim() !== "";
  elements.btnReport.disabled = !hasUrl || !hasName;
}

/**
 * アプリ URL 入力欄の変化に合わせて文字数カウンターと送信ボタンを更新する
 * ※ 関数名は旧 handleTaskInput から handleAppUrlInput に変更
 */
function handleAppUrlInput() {
  const len = elements.appUrlInput.value.length;
  elements.charCount.textContent = len;

  // URL が 1 文字以上 かつ 氏名が入力済みのときだけ送信ボタンを有効にする
  const hasName = state.name.trim() !== "";
  elements.btnReport.disabled = len === 0 || !hasName;
}

/**
 * 課題完了報告の送信ボタンが押されたときの処理
 * ※ 関数名は旧 handleReport から handleCompleteTask に変更
 * ※ GAS の action: "completeTask" に対応
 */
async function handleCompleteTask() {
  // 氏名の取得と空欄チェック
  const name = elements.nameInput.value.trim();
  if (!name) {
    showToast("氏名を入力してください", "error");
    return;
  }

  // 入力値を取得して前後の空白を除く
  const appUrl = elements.appUrlInput.value.trim();

  // --- バリデーション ---
  // 空欄チェック（HTML の required と二重で守る）
  if (!appUrl) {
    showToast("アプリURLを入力してください", "error");
    return;
  }

  setButtonLoading(elements.btnReport);

  try {
    // GAS へ送るデータを組み立てる
    const body = {
      action:     "completeTask",
      employeeId: EMPLOYEE_ID,
      name:       name,            // 氏名入力欄から取得
      appUrl:     appUrl,
      timestamp:  getCurrentTimestamp(),
    };

    const result = await postToGAS(body);

    if (result.status === "ok") {
      // 成功: フォームをリセット (氏名欄はリセットしない)
      elements.appUrlInput.value     = "";
      elements.charCount.textContent = "0";
      elements.btnReport.disabled    = true;
      showToast(result.message, "success");
    } else {
      showToast(result.message, "error");
    }

  } catch (err) {
    showToast(err.message, "error");
  } finally {
    clearButtonLoading(elements.btnReport);
    // 送信ボタンの disabled は「URL あり AND 氏名あり」で再判定
    const hasUrl  = elements.appUrlInput.value.trim().length > 0;
    const hasName = state.name.trim() !== "";
    elements.btnReport.disabled = !hasUrl || !hasName;
  }
}

/* ============================================================
   13. イベントリスナーの登録
   ============================================================ */

/**
 * 各要素にイベントリスナーを登録する
 * init() から呼ばれる
 */
function registerEventListeners() {
  // 氏名入力欄: 入力のたびにボタン状態を更新
  elements.nameInput.addEventListener("input", handleNameInput);

  // 打刻ボタン
  elements.btnClockIn.addEventListener("click",  handleClockIn);
  elements.btnClockOut.addEventListener("click", handleClockOut);

  // アプリURL入力欄: 入力のたびにカウンターとボタン状態を更新
  elements.appUrlInput.addEventListener("input", handleAppUrlInput);

  // 課題完了報告の送信ボタン
  elements.btnReport.addEventListener("click", handleCompleteTask);
}

/* ============================================================
   14. 初期化
   ページ読み込み時に一度だけ実行する
   ============================================================ */

/**
 * アプリの初期化処理
 */
function init() {
  // 1. localStorage から打刻状態と氏名をまとめて復元する
  //    （name / clockIn / clockOut が1つのキーで保存されているため不整合が起きない）
  loadState();

  // 2. 復元した state.name を氏名入力欄に反映する
  renderNameInput();

  // 3. 日付をヘッダーに表示
  renderDate();

  // 4. 復元した state で UI を初期描画
  updateUI();

  // 5. 現在時刻を即時描画 + 1 秒ごとに更新
  updateClock();
  setInterval(updateClock, 1000);

  // 6. イベントリスナーを登録
  registerEventListeners();

  // 7. Service Worker を登録 (PWA 対応)
  registerServiceWorker();
}

/* ============================================================
   15. Service Worker の登録 (PWA)
   ============================================================ */

/**
 * Service Worker を登録する
 * Service Worker が使えないブラウザでもエラーにならないよう
 * 対応チェックを行ってから登録する
 */
function registerServiceWorker() {
  // "serviceWorker" が navigator に存在しない = 非対応ブラウザ
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker
    .register("./sw.js")
    .then(() => {
      console.log("Service Worker を登録しました");
    })
    .catch((err) => {
      console.warn("Service Worker の登録に失敗しました:", err);
    });
}

/* ============================================================
   16. エントリーポイント
   DOM の読み込み完了後に init() を呼ぶ
   ============================================================ */

// DOMContentLoaded: HTML の解析が終わり DOM が操作できる状態になったら発火する
// script タグを body の末尾に置いているので基本的には不要だが
// 明示的に書くことで「DOM 依存の処理はここから」と分かりやすくする
document.addEventListener("DOMContentLoaded", init);
