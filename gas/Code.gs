/**
 * Code.gs
 * GAS ウェブアプリのエントリーポイント。
 *
 * フロントエンドからの POST リクエストをここで受け取り、
 * action フィールドの値で処理を振り分ける（ルーター）。
 *
 * 責務: リクエストの受付・振り分け・レスポンスの返却のみ。
 *       スプレッドシートや LINE の操作は各モジュールに委譲する。
 *
 * 依存:
 *   utils.gs  — parseRequestBody, createJsonResponse, formatDateJST, now
 *   sheet.gs  — validateTraineeMaster, updateTraineeStatus,
 *               appendAttendanceRow, updateAttendanceClockOut, appendTaskRow
 *   line.gs   — buildClockInMessage, buildClockOutMessage,
 *               buildCompleteTaskMessage, notifyLine
 *
 * デプロイ設定:
 *   実行者: 自分
 *   アクセスできるユーザー: 全員
 *   ※「全員」にしないとフロントエンドから認証なしでアクセスできない
 */

// =====================================================
// 1. doPost — メインルーター
// =====================================================

/**
 * POST リクエストを受け取るエントリーポイント。
 * GAS のウェブアプリとしてデプロイすると、POST を受け取るたびにこの関数が呼ばれる。
 *
 * @param {GoogleAppsScript.Events.DoPost} e  GAS が自動で渡すイベントオブジェクト
 * @returns {GoogleAppsScript.Content.TextOutput}  JSON レスポンス
 */
function doPost(e) {
  // --- リクエストボディのパース ---
  const body = parseRequestBody(e);

  // JSON が壊れている、または body が空の場合は 400 相当のエラーを返す
  if (!body) {
    return createJsonResponse("error", "リクエストボディが不正です");
  }

  // --- action による振り分け ---
  const action = body.action;

  try {
    if (action === "clockIn") {
      return handleClockIn(body);
    }

    if (action === "clockOut") {
      return handleClockOut(body);
    }

    if (action === "completeTask") {
      return handleCompleteTask(body);
    }

    if (action === "getStatus") {
      return handleGetStatus(body);
    }

    // 未知の action は 400 相当のエラーを返す
    return createJsonResponse("error", `不明な action です: ${action}`);

  } catch (err) {
    // 予期しない例外をログに残してクライアントへエラーを返す
    Logger.log(`[doPost エラー] action=${action}, message=${err.message}`);
    return createJsonResponse("error", `サーバーエラーが発生しました: ${err.message}`);
  }
}

// =====================================================
// 2. action ハンドラ — 出勤打刻
// =====================================================

/**
 * 出勤打刻を処理する。
 *
 * 処理の流れ:
 *   1. フィールドの有無チェック（validateCommonFields）
 *   2. 研修生マスタの存在確認・名前照合（validateTraineeMaster）  ← 追加
 *   3. 打刻記録シートに出勤レコードを追加
 *   4. 研修生マスタのステータスを「出勤中」に更新               ← 追加
 *   5. LINE に出勤通知を送信
 *   6. 成功レスポンスを返す
 *
 * @param {{ employeeId: string, name: string, timestamp: string }} body
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function handleClockIn(body) {
  // --- ステップ 1: フィールドの有無チェック ---
  const fieldError = validateCommonFields(body);
  if (fieldError) return createJsonResponse("error", fieldError);

  // スクリプトプロパティを取得（設定漏れがあれば例外が投げられ doPost の catch に渡る）
  const props = getScriptProperties();

  // --- ステップ 2: 打刻記録に出勤レコードを追記 ---
  // 氏名はフロントの入力欄から受け取った値をそのまま記録する（マスタ照合なし）
  const clockInDate             = now(); // 打刻時刻は GAS サーバー側の時刻を使う
  const { clockInTime }         = appendAttendanceRow(props.spreadsheetId, body, clockInDate);

  // --- ステップ 3: LINE 通知（失敗しても打刻記録には影響しない）---
  const lineMessage = buildClockInMessage({
    name:        body.name,
    clockInTime: clockInTime,
    todayStr:    formatDateJST(clockInDate),
  });
  notifyLine(props.lineToken, props.lineGroupId, lineMessage);

  return createJsonResponse("ok", `出勤打刻を記録しました（${clockInTime}）`);
}

// =====================================================
// 3. action ハンドラ ― 退勤打刻
// =====================================================

/**
 * 退勤打刻を処理する。
 *
 * 処理の流れ:
 *   1. フィールドの有無チェック
 *   2. 研修生マスタの存在確認・名前照合                        ← 追加
 *   3. 打刻記録シートの当日行に退勤時刻・勤務時間を書き込む
 *   4. 研修生マスタのステータスを「退勤済み」に更新            ← 追加
 *   5. LINE に退勤通知を送信
 *   6. 成功レスポンスを返す
 *
 * @param {{ employeeId: string, name: string, timestamp: string }} body
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function handleClockOut(body) {
  // --- ステップ 1: フィールドの有無チェック ---
  const fieldError = validateCommonFields(body);
  if (fieldError) return createJsonResponse("error", fieldError);

  const props = getScriptProperties();

  // --- ステップ 2: 打刻記録の当日行に退勤時刻・勤務時間を書き込む ---
  // 氏名はフロントの入力欄から受け取った値をそのまま使う（マスタ照合なし）
  // 出勤レコードなし / 退勤済み / 退勤が出勤より前 の場合は例外が投げられる
  const clockOutDate = now();
  const result       = updateAttendanceClockOut(props.spreadsheetId, body, clockOutDate);

  // --- ステップ 3: LINE 通知 ---
  const lineMessage = buildClockOutMessage({
    name:         body.name,
    clockInTime:  result.clockInTime,
    clockOutTime: result.clockOutTime,
    workDuration: result.workDuration,
    todayStr:     formatDateJST(clockOutDate),
  });
  notifyLine(props.lineToken, props.lineGroupId, lineMessage);

  return createJsonResponse(
    "ok",
    `退勤打刻を記録しました（${result.clockOutTime} / 勤務時間: ${result.workDuration}）`
  );
}

// =====================================================
// 4. action ハンドラ — 課題完了報告
// =====================================================

/**
 * 課題完了報告を処理する。
 *
 * 処理の流れ:
 *   1. フィールドの有無チェック（共通 + appUrl）
 *   2. 研修生マスタの存在確認・名前照合                        ← 追加
 *   3. 課題完了記録シートに追記（判定列に "未確認" をセット）
 *   4. LINE に課題完了通知を送信
 *   5. 成功レスポンスを返す
 *   ※ completeTask ではステータス更新は行わない
 *
 * @param {{ employeeId: string, name: string, appUrl: string, timestamp: string }} body
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function handleCompleteTask(body) {
  // --- ステップ 1: フィールドの有無チェック ---
  const fieldError = validateCommonFields(body);
  if (fieldError) return createJsonResponse("error", fieldError);

  // appUrl フィールドの追加チェック
  if (!body.appUrl || body.appUrl.trim() === "") {
    return createJsonResponse("error", "アプリ URL が空です");
  }

  const props = getScriptProperties();

  // --- ステップ 2: 課題完了記録シートに追記 ---
  // 氏名はフロントの入力欄から受け取った値をそのまま記録する（マスタ照合なし）
  const reportDate         = now();
  const { reportedAt }     = appendTaskRow(props.spreadsheetId, body, reportDate);

  // --- ステップ 3: LINE 通知 ---
  const lineMessage = buildCompleteTaskMessage({
    name:       body.name,
    appUrl:     body.appUrl.trim(),
    reportedAt: reportedAt,
  });
  notifyLine(props.lineToken, props.lineGroupId, lineMessage);

  return createJsonResponse("ok", "課題完了報告を送信しました");
}

// =====================================================
// 5. action ハンドラ — 当日打刻状態の確認
// =====================================================

/**
 * 氏名をキーに当日の打刻状態をスプレッドシートから取得して返す。
 *
 * フロントエンドが氏名入力後に呼び出し、
 * 「すでに出勤済みか」「退勤済みか」をサーバー側の実態に基づいて確認するために使う。
 * これにより別デバイスで打刻した場合でも正しい状態が反映される。
 *
 * レスポンス例:
 *   { status: "ok", clockInTime: "09:00", clockOutTime: null }   // 出勤済み・退勤待ち
 *   { status: "ok", clockInTime: "09:00", clockOutTime: "18:00" } // 退勤済み
 *   { status: "ok", clockInTime: null,    clockOutTime: null }   // 未出勤
 *
 * @param {{ employeeId: string, name: string }} body
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function handleGetStatus(body) {
  // 氏名の空欄チェック
  if (!body.name || body.name.trim() === "") {
    return createJsonResponse("error", "氏名が指定されていません");
  }

  const props  = getScriptProperties();
  const result = getTodayStatusByName(props.spreadsheetId, body.name.trim());

  // createJsonResponse は status / message の 2 フィールドしか持てないため
  // 追加データ（clockInTime / clockOutTime）を含む JSON を直接組み立てて返す
  const payload = JSON.stringify({
    status:       "ok",
    message:      "状態を取得しました",
    clockInTime:  result.clockInTime,
    clockOutTime: result.clockOutTime,
  });
  return ContentService
    .createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}

// =====================================================
// 6. バリデーション
// =====================================================

/**
 * 全 action 共通の必須フィールドをチェックする。
 *
 * ここでは「フィールドが存在するか・空でないか」だけを確認する。
 * 研修生マスタとの照合は validateTraineeMaster() が担う。
 *
 * @param {Object} body  パース済みリクエストボディ
 * @returns {string|null}  エラーメッセージ文字列、問題なければ null
 */
function validateCommonFields(body) {
  if (!body.employeeId || body.employeeId.trim() === "") {
    return "研修生ID（employeeId）が指定されていません";
  }
  if (!body.name || body.name.trim() === "") {
    return "氏名（name）が指定されていません";
  }
  return null; // エラーなし
}
