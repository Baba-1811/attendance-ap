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
 *   sheet.gs  — getOrCreateTrainee, findTraineeByName, updateMasterStatus,
 *               appendAttendanceRow, updateAttendanceClockOut, appendTaskRow,
 *               getTodayStatusByName
 *   line.gs   — buildClockInMessage, buildClockOutMessage,
 *               buildCompleteTaskMessage, notifyLine
 *
 * デプロイ設定:
 *   実行者: 自分
 *   アクセスできるユーザー: 全員
 *   ※「全員」にしないとフロントエンドから認証なしでアクセスできない
 *
 * ID 管理方針:
 *   フロントエンドは氏名のみ送信。GAS が研修生マスタを名前で検索し、
 *   未登録なら自動採番（user01, user02...）して新規登録する。
 *   同じ名前は同一人物とみなす（同名別人は今回スコープ外）。
 */

// =====================================================
// 0. doGet — デプロイ確認用（ブラウザで GAS URL を開いたとき呼ばれる）
// =====================================================

/**
 * ブラウザで Web アプリ URL を開いたときに呼ばれる。
 * このレスポンスが返れば「新しいコードが動いている」と確認できる。
 *
 * 確認方法: GAS_URL をブラウザで開く
 *   → { "version": "3.0.0", "feature": "getOrCreateTrainee 対応済み" } が返れば OK
 */
function doGet(e) {
  const payload = JSON.stringify({
    version: "3.0.0",
    feature: "getOrCreateTrainee 対応済み",
    timestamp: new Date().toISOString(),
  });
  return ContentService
    .createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}

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
  const body = parseRequestBody(e);

  if (!body) {
    return createJsonResponse("error", "リクエストボディが不正です");
  }

  const action = body.action;

  try {
    if (action === "clockIn")       return handleClockIn(body);
    if (action === "clockOut")      return handleClockOut(body);
    if (action === "completeTask")  return handleCompleteTask(body);
    if (action === "getStatus")     return handleGetStatus(body);

    return createJsonResponse("error", `不明な action です: ${action}`);

  } catch (err) {
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
 *   1. 氏名の有無チェック
 *   2. 研修生マスタで名前を検索 → 未登録なら自動採番して新規作成
 *   3. 打刻記録シートに出勤レコードを追加（重複チェックあり）
 *   4. LINE に出勤通知を送信
 *   5. 成功レスポンスを返す
 *
 * @param {{ name: string, timestamp: string }} body
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function handleClockIn(body) {
  const fieldError = validateCommonFields(body);
  if (fieldError) return createJsonResponse("error", fieldError);

  const props = getScriptProperties();

  // 研修生マスタから ID を解決（未登録なら自動採番で新規登録）
  const trainee     = getOrCreateTrainee(props.spreadsheetId, body.name.trim());
  const clockInDate = now();
  const { clockInTime } = appendAttendanceRow(
    props.spreadsheetId,
    { employeeId: trainee.id, name: trainee.name },
    clockInDate
  );

  const lineOk = notifyLine(
    props.lineToken,
    props.lineGroupId,
    buildClockInMessage({ name: trainee.name, clockInTime, todayStr: formatDateJST(clockInDate) })
  );
  const lineSuffix = lineOk ? "" : "（LINE通知は失敗しました。管理者に連絡してください）";

  return createJsonResponse("ok", `出勤打刻を記録しました（${clockInTime}）${lineSuffix}`);
}

// =====================================================
// 3. action ハンドラ — 退勤打刻
// =====================================================

/**
 * 退勤打刻を処理する。
 *
 * 処理の流れ:
 *   1. 氏名の有無チェック
 *   2. 打刻記録シートの当日・同氏名・未退勤行を探して退勤時刻・勤務時間を書き込む
 *   3. LINE に退勤通知を送信
 *   4. 成功レスポンスを返す
 *
 * 退勤は name で行を特定するため、ID 解決は不要。
 *
 * @param {{ name: string, timestamp: string }} body
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function handleClockOut(body) {
  const fieldError = validateCommonFields(body);
  if (fieldError) return createJsonResponse("error", fieldError);

  const props        = getScriptProperties();
  const clockOutDate = now();
  const result       = updateAttendanceClockOut(props.spreadsheetId, body, clockOutDate);

  const lineOk = notifyLine(
    props.lineToken,
    props.lineGroupId,
    buildClockOutMessage({
      name:         body.name.trim(),
      clockInTime:  result.clockInTime,
      clockOutTime: result.clockOutTime,
      workDuration: result.workDuration,
      todayStr:     formatDateJST(clockOutDate),
    })
  );
  const lineSuffix = lineOk ? "" : "（LINE通知は失敗しました。管理者に連絡してください）";

  return createJsonResponse(
    "ok",
    `退勤打刻を記録しました（${result.clockOutTime} / 勤務時間: ${result.workDuration}）${lineSuffix}`
  );
}

// =====================================================
// 4. action ハンドラ — 課題完了報告
// =====================================================

/**
 * 課題完了報告を処理する。
 *
 * 処理の流れ:
 *   1. 氏名・appUrl の有無チェック
 *   2. 研修生マスタで名前を検索 → 未登録なら自動採番して新規作成
 *   3. 課題完了記録シートに追記（判定列に "未確認" をセット）
 *   4. 研修生マスタのステータスを「確認待ち」に更新
 *   5. LINE に課題完了通知を送信
 *   6. 成功レスポンスを返す
 *
 * @param {{ name: string, appUrl: string, timestamp: string }} body
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function handleCompleteTask(body) {
  const fieldError = validateCommonFields(body);
  if (fieldError) return createJsonResponse("error", fieldError);

  if (!body.appUrl || body.appUrl.trim() === "") {
    return createJsonResponse("error", "アプリ URL が空です");
  }

  const props = getScriptProperties();

  // 研修生マスタから ID を解決（未登録なら自動採番で新規登録）
  const trainee    = getOrCreateTrainee(props.spreadsheetId, body.name.trim());
  const reportDate = now();
  const { reportedAt } = appendTaskRow(
    props.spreadsheetId,
    { employeeId: trainee.id, name: trainee.name, appUrl: body.appUrl.trim() },
    reportDate
  );

  // 研修生マスタのステータスを「確認待ち」に更新
  updateMasterStatus(props.spreadsheetId, trainee.name, "確認待ち");

  const lineOk = notifyLine(
    props.lineToken,
    props.lineGroupId,
    buildCompleteTaskMessage({
      name:       trainee.name,
      employeeId: trainee.id,
      appUrl:     body.appUrl.trim(),
      reportedAt: reportedAt,
    })
  );
  const lineSuffix = lineOk ? "" : "（LINE通知は失敗しました。管理者に連絡してください）";

  return createJsonResponse("ok", `課題完了報告を送信しました${lineSuffix}`);
}

// =====================================================
// 5. action ハンドラ — 当日打刻状態の確認
// =====================================================

/**
 * 氏名をキーに当日の打刻状態と研修生IDをスプレッドシートから取得して返す。
 *
 * フロントエンドが氏名入力後（500ms デバウンス）に呼び出し、
 * サーバー側の実態に基づいてボタン状態を補正するために使う。
 *
 * ※ このアクションでは新規登録を行わない（findTraineeByName を使用）。
 *    未打刻の人が名前を入力するたびにマスタ行が増えるのを防ぐため。
 *
 * レスポンス例:
 *   { status: "ok", clockInTime: "09:00", clockOutTime: null,    employeeId: "user01" }
 *   { status: "ok", clockInTime: "09:00", clockOutTime: "18:00", employeeId: "user01" }
 *   { status: "ok", clockInTime: null,    clockOutTime: null,    employeeId: null }  // 未登録
 *
 * @param {{ name: string }} body
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function handleGetStatus(body) {
  if (!body.name || body.name.trim() === "") {
    return createJsonResponse("error", "氏名が指定されていません");
  }

  const props   = getScriptProperties();
  const name    = body.name.trim();
  const result  = getTodayStatusByName(props.spreadsheetId, name);
  const trainee = findTraineeByName(props.spreadsheetId, name); // 新規作成なし

  const payload = JSON.stringify({
    status:       "ok",
    message:      "状態を取得しました",
    clockInTime:  result.clockInTime,
    clockOutTime: result.clockOutTime,
    employeeId:   trainee ? trainee.id : null,
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
 * employeeId は GAS 側で研修生マスタから自動解決するため、
 * フロントエンドからは name のみを必須フィールドとする。
 *
 * @param {Object} body  パース済みリクエストボディ
 * @returns {string|null}  エラーメッセージ文字列、問題なければ null
 */
function validateCommonFields(body) {
  if (!body.name || body.name.trim() === "") {
    return "氏名（name）が指定されていません";
  }
  return null;
}
