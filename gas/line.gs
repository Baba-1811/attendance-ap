/**
 * line.gs
 * LINE Messaging API を使ったグループへのプッシュ通知をすべてここに集約する。
 *
 * 責務: LINE へのメッセージ送信のみ。スプレッドシート操作や HTTP レスポンスは扱わない。
 * 依存: なし（utils.gs にも依存しない独立したモジュール）
 *
 * 使用 API: LINE Messaging API - Push Message
 *   https://developers.line.biz/ja/reference/messaging-api/#send-push-message
 *
 * 通知の設計方針:
 *   - LINE 通知の失敗はアプリの主要処理（打刻記録）を止めない
 *   - 失敗した場合は Logger.log でログを残す
 *   - 呼び出し元（Code.gs）で try-catch せずにそのまま呼べる設計
 */

// LINE Messaging API のエンドポイント（変更されることはほぼないが定数として管理）
const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

// =====================================================
// 1. メッセージの送信
// =====================================================

/**
 * LINE グループへテキストメッセージをプッシュ送信する。
 *
 * LINE Messaging API の Push Message を使う。
 * UrlFetchApp.fetch は GAS の HTTP クライアント。
 *
 * @param {string} lineToken    チャネルアクセストークン（スクリプトプロパティから取得）
 * @param {string} lineGroupId  送信先グループ ID（スクリプトプロパティから取得）
 * @param {string} message      送信するテキストメッセージ
 * @throws {Error} HTTP リクエストが失敗した場合（200 以外のレスポンスコード）
 */
function sendLineMessage(lineToken, lineGroupId, message) {
  // リクエストボディ: LINE API の仕様に従って組み立てる
  const requestBody = {
    to: lineGroupId,
    messages: [
      {
        type: "text",
        text: message,
      },
    ],
  };

  // UrlFetchApp.fetch のオプション
  const options = {
    method:  "post",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${lineToken}`, // Bearer トークン認証
    },
    payload:            JSON.stringify(requestBody),
    muteHttpExceptions: true, // HTTP エラー時に例外を投げず、レスポンスとして受け取る
  };

  const response     = UrlFetchApp.fetch(LINE_PUSH_URL, options);
  const responseCode = response.getResponseCode();

  // 200 以外はエラーとして扱う
  if (responseCode !== 200) {
    const body = response.getContentText();
    throw new Error(`LINE API エラー (HTTP ${responseCode}): ${body}`);
  }
}

// =====================================================
// 2. メッセージ文字列の組み立て
// =====================================================

/**
 * 出勤通知のメッセージ文字列を組み立てて返す。
 *
 * @param {{ name: string, clockInTime: string, todayStr: string }} info
 * @returns {string}
 *
 * 出力例:
 *   【出勤】
 *   山田 太郎
 *   日時: 2026/03/17 09:00
 */
function buildClockInMessage(info) {
  return [
    `【出勤】`,
    `${info.name}`,
    `${info.todayStr} ${info.clockInTime}`,
  ].join("\n");
}

/**
 * 退勤通知のメッセージ文字列を組み立てて返す。
 *
 * @param {{ name: string, clockInTime: string, clockOutTime: string, workDuration: string, todayStr: string }} info
 * @returns {string}
 *
 * 出力例:
 *   【退勤】
 *   山田 太郎
 *   出勤: 09:00 → 退勤: 18:00
 *   勤務時間: 9時間0分
 */
function buildClockOutMessage(info) {
  return [
    `【退勤】`,
    `${info.name}`,
    `出勤：${info.clockInTime}`,
    `退勤：${info.clockOutTime}`,
    `勤務：${info.workDuration}`,
  ].join("\n");
}

/**
 * 課題完了報告通知のメッセージ文字列を組み立てて返す。
 *
 * @param {{ name: string, employeeId: string, appUrl: string, reportedAt: string }} info
 * @returns {string}
 *
 * 出力例:
 *   【🎉課題完了報告🎉】
 *   研修生: 山田 太郎（user03）
 *   完了: 2026/03/17 17:55
 *   アプリURL: https://example.github.io/my-app/
 *   確認をお願いします！
 */
function buildCompleteTaskMessage(info) {
  return [
    `【🎉課題完了報告🎉】`,
    `研修生：${info.name}（${info.employeeId}）`,
    `完了：${info.reportedAt}`,
    `アプリURL:`,
    `${info.appUrl}`,
    `確認をお願いします！`,
  ].join("\n");
}

// =====================================================
// 3. 通知の実行（送信 + ログ）をまとめたラッパー関数
// =====================================================

/**
 * LINE 通知を送信し、成功・失敗をログに記録する。
 *
 * 通知の失敗はアプリの主処理（打刻記録）を止めないために、
 * この関数自体は例外を外へ投げない。
 * 代わりに Logger.log でエラー内容を GAS のログに残す。
 *
 * 呼び出し側（Code.gs）ではこの関数を try-catch なしで呼べる。
 *
 * @param {string} lineToken
 * @param {string} lineGroupId
 * @param {string} message
 */
/**
 * LINE 通知を送信し、成否を boolean で返す。
 *
 * 失敗しても例外は投げない。呼び出し元（Code.gs）が戻り値を見て
 * レスポンスメッセージに「LINE通知失敗」を付加できる。
 *
 * @returns {boolean} 送信成功なら true、失敗なら false
 */
function notifyLine(lineToken, lineGroupId, message) {
  try {
    sendLineMessage(lineToken, lineGroupId, message);
    Logger.log("LINE 通知送信成功: " + message.split("\n")[0]);
    return true;
  } catch (err) {
    Logger.log("LINE 通知送信失敗: " + err.message);
    return false;
  }
}
