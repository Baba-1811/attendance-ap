/**
 * utils.gs
 * 複数のファイルから呼ばれる汎用ユーティリティ関数をまとめたファイル
 *
 * ここには「特定の業務ロジック（打刻・LINE 通知など）に依存しない」
 * 汎用的な処理だけを置く。
 * 依存関係: なし（他の .gs ファイルに依存しない）
 */

// ============================================================
// 1. Script Properties（スクリプトプロパティ）の取得
// ============================================================

/**
 * スクリプトプロパティをまとめて取得してオブジェクトで返す。
 *
 * スクリプトプロパティとは GAS の「設定 > スクリプトプロパティ」画面で
 * 設定できるキーバリュー形式の秘密情報置き場。
 * コード内にトークンや ID を直接書くとセキュリティリスクがあるため、
 * 必ずここから取得するようにする。
 *
 * 設定が必要なプロパティ:
 *   SPREADSHEET_ID           : スプレッドシートの ID（URL の /d/〜/edit 間の文字列）
 *   LINE_CHANNEL_ACCESS_TOKEN: LINE Messaging API のチャネルアクセストークン
 *   LINE_GROUP_ID            : 通知先の LINE グループ ID
 *
 * @returns {{ spreadsheetId: string, lineToken: string, lineGroupId: string }}
 * @throws {Error} 必須プロパティが未設定の場合
 */
function getScriptProperties() {
  const props = PropertiesService.getScriptProperties();

  const spreadsheetId = props.getProperty("SPREADSHEET_ID");
  const lineToken     = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  const lineGroupId   = props.getProperty("LINE_GROUP_ID");

  // 必須プロパティが設定されていない場合は早期に例外を投げる
  // （設定漏れを実行時にすぐ気づけるようにするため）
  if (!spreadsheetId) throw new Error("スクリプトプロパティ SPREADSHEET_ID が未設定です");
  if (!lineToken)     throw new Error("スクリプトプロパティ LINE_CHANNEL_ACCESS_TOKEN が未設定です");
  if (!lineGroupId)   throw new Error("スクリプトプロパティ LINE_GROUP_ID が未設定です");

  return { spreadsheetId, lineToken, lineGroupId };
}

// ============================================================
// 2. 日付・時刻のフォーマット（Asia/Tokyo 固定）
// ============================================================

/**
 * Date オブジェクトを日本時間の "YYYY/MM/DD" 形式に変換する。
 *
 * GAS のデフォルトタイムゾーンはスプレッドシートの設定に依存するため、
 * Utilities.formatDate で明示的に "Asia/Tokyo" を指定して確実に JST で処理する。
 *
 * @param {Date} date
 * @returns {string}  例: "2026/03/17"
 */
function formatDateJST(date) {
  return Utilities.formatDate(date, "Asia/Tokyo", "yyyy/MM/dd");
}

/**
 * Date オブジェクトを日本時間の "HH:MM" 形式に変換する。
 *
 * @param {Date} date
 * @returns {string}  例: "09:00"
 */
function formatTimeJST(date) {
  return Utilities.formatDate(date, "Asia/Tokyo", "HH:mm");
}

/**
 * Date オブジェクトを日本時間の "YYYY/MM/DD HH:MM" 形式に変換する。
 * 課題報告シートの「日時」列に使う。
 *
 * @param {Date} date
 * @returns {string}  例: "2026/03/17 17:55"
 */
function formatDateTimeJST(date) {
  return Utilities.formatDate(date, "Asia/Tokyo", "yyyy/MM/dd HH:mm");
}

/**
 * 現在日時の Date オブジェクトを返す。
 * テスト時にモックしやすいよう、new Date() を直接使う箇所をここに集約する。
 *
 * @returns {Date}
 */
function now() {
  return new Date();
}

// ============================================================
// 3. 勤務時間の計算
// ============================================================

/**
 * 出勤・退勤の "HH:MM" 文字列から勤務時間を分単位で返す。
 *
 * 例: calcWorkMinutes("09:00", "18:00") => 540
 *
 * @param {string} clockInTime   例: "09:00"
 * @param {string} clockOutTime  例: "18:00"
 * @returns {number}  勤務分数。退勤が出勤より前の場合は負の値になる。
 */
function calcWorkMinutes(clockInTime, clockOutTime) {
  const [inHour,  inMin]  = clockInTime.split(":").map(Number);
  const [outHour, outMin] = clockOutTime.split(":").map(Number);
  return (outHour * 60 + outMin) - (inHour * 60 + inMin);
}

/**
 * 勤務分数を "X時間Y分" の日本語文字列に変換する。
 *
 * 例: formatWorkDuration(540) => "9時間0分"
 *
 * @param {number} totalMinutes
 * @returns {string}
 */
function formatWorkDuration(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const mins  = totalMinutes % 60;
  return `${hours}時間${mins}分`;
}

// ============================================================
// 4. レスポンス生成
// ============================================================

/**
 * フロントエンドへ返す JSON レスポンスを ContentService で生成して返す。
 *
 * GAS の doPost では return で ContentService オブジェクトを返すことで
 * HTTP レスポンスボディを設定できる。
 * MimeType.JSON を指定すると Content-Type: application/json が付与される。
 *
 * @param {"ok"|"error"} status   処理結果
 * @param {string}       message  ユーザー向けメッセージ（日本語）
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function createJsonResponse(status, message) {
  const payload = JSON.stringify({ status, message });
  return ContentService
    .createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST ボディの JSON 文字列をパースして Object を返す。
 * パースに失敗した場合は null を返す。
 *
 * @param {GoogleAppsScript.Events.DoPost} e  doPost の引数
 * @returns {Object|null}
 */
function parseRequestBody(e) {
  try {
    return JSON.parse(e.postData.contents);
  } catch (_) {
    return null;
  }
}
