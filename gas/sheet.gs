/**
 * sheet.gs
 * Google スプレッドシートへの読み書きをすべてここに集約する。
 *
 * 責務: スプレッドシートの操作のみ。LINE 通知や HTTP レスポンスは扱わない。
 * 依存: utils.gs（formatDateJST, formatTimeJST, formatDateTimeJST,
 *                  calcWorkMinutes, formatWorkDuration）
 *
 * =====================================================
 * 実際のシート構成
 * =====================================================
 *
 * 【研修生マスタ】シート  ← 今回追加
 *   A列: 研修生ID   "EMP001"
 *   B列: 名前       "山田 太郎"
 *   C列: ステータス "出勤中" / "退勤済み" など
 *
 * 【打刻記録】シート
 *   A列: 日付       "YYYY/MM/DD"
 *   B列: 研修生ID   "EMP001"
 *   C列: 指名       "山田 太郎"  ※見出しは「指名」だがコード内では name で扱う
 *   D列: 打刻時刻   "09:00"      ※出勤時刻として扱う
 *   E列: 退勤時刻   "18:00"
 *   F列: 勤務時間   540          ※分単位の数値
 *
 * 【課題完了記録】シート
 *   A列: 完了日時   "YYYY/MM/DD HH:MM"
 *   B列: 研修生ID   "EMP001"
 *   C列: 指名       "山田 太郎"
 *   D列: アプリURL  "https://..."
 *   E列: 判定       "未確認"（初期値）
 */

// =====================================================
// シート名の定数
// シート名を変更したい場合はここだけ直せばよい
// =====================================================
const SHEET_NAME_MASTER     = "研修生マスタ";  // 追加
const SHEET_NAME_ATTENDANCE = "打刻記録";
const SHEET_NAME_TASK       = "課題完了記録";

// =====================================================
// 研修生マスタシートの列番号（1 始まり）
// 他の列定数と名前が衝突しないよう COL_MASTER_ という prefix を付ける
// =====================================================
const COL_MASTER_ID     = 1; // A列: 研修生ID
const COL_MASTER_NAME   = 2; // B列: 名前
const COL_MASTER_STATUS = 3; // C列: ステータス

// =====================================================
// 打刻記録シートの列番号（1 始まり）
// =====================================================
const COL_DATE         = 1; // A列: 日付
const COL_EMPLOYEE_ID  = 2; // B列: 研修生ID
const COL_NAME         = 3; // C列: 指名
const COL_CLOCK_IN     = 4; // D列: 打刻時刻（出勤）
const COL_CLOCK_OUT    = 5; // E列: 退勤時刻
const COL_WORK_MINUTES = 6; // F列: 勤務時間（分）

// =====================================================
// 1. シートオブジェクトの取得（汎用）
// =====================================================

/**
 * スプレッドシートを開いて指定したシートを返す。
 * シートが見つからない場合は例外を投げる。
 *
 * この関数は他の getXxxSheet() 関数から内部的に呼ばれる汎用ヘルパー。
 *
 * @param {string} spreadsheetId  スクリプトプロパティから取得した ID
 * @param {string} sheetName      シート名
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 * @throws {Error} シートが存在しない場合
 */
function getSheet(spreadsheetId, sheetName) {
  const ss    = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    throw new Error(`シート「${sheetName}」が見つかりません。シート名を確認してください。`);
  }

  return sheet;
}

// =====================================================
// 2. 研修生マスタシートの操作
// =====================================================

/**
 * 研修生マスタシートを取得して返す。
 *
 * getSheet() の薄いラッパー。
 * Code.gs など呼び出し元がシート名を意識しなくて済むようにする。
 *
 * @param {string} spreadsheetId
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getTraineeMasterSheet(spreadsheetId) {
  return getSheet(spreadsheetId, SHEET_NAME_MASTER);
}

/**
 * 研修生マスタシートから、指定した研修生IDの行番号を探して返す。
 *
 * 見つからなかった場合は null を返す。
 * 呼び出し元で null チェックをして「未登録」エラーを返す。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet  研修生マスタシート
 * @param {string} employeeId  検索する研修生ID
 * @returns {number|null}  見つかった行番号（1 始まり）または null
 */
function findTraineeRowById(sheet, employeeId) {
  const lastRow = sheet.getLastRow();

  // データが 1 行もない（ヘッダーのみ）場合は即 null
  if (lastRow < 2) return null;

  // 2 行目から最終行まで A〜C 列を一括取得する
  const values = sheet.getRange(2, 1, lastRow - 1, COL_MASTER_STATUS).getValues();

  for (let i = 0; i < values.length; i++) {
    const rowId = String(values[i][COL_MASTER_ID - 1]); // A列（配列は 0 始まり）

    if (rowId === employeeId) {
      // ヘッダー行を除いているので +2
      return i + 2;
    }
  }

  return null; // 見つからなかった
}

/**
 * 研修生IDをキーに研修生マスタを検索し、研修生データを返す。
 *
 * 見つかった場合は { id, name, status } のオブジェクトを返す。
 * 見つからなかった場合は null を返す。
 *
 * @param {string} spreadsheetId
 * @param {string} employeeId
 * @returns {{ id: string, name: string, status: string }|null}
 */
function getTraineeById(spreadsheetId, employeeId) {
  const sheet     = getTraineeMasterSheet(spreadsheetId);
  const targetRow = findTraineeRowById(sheet, employeeId);

  if (!targetRow) return null;

  // 対象行の A〜C 列を取得する
  const values = sheet.getRange(targetRow, 1, 1, COL_MASTER_STATUS).getValues()[0];

  return {
    id:     String(values[COL_MASTER_ID     - 1]),
    name:   String(values[COL_MASTER_NAME   - 1]),
    status: String(values[COL_MASTER_STATUS - 1]),
  };
}

/**
 * 研修生マスタの存在確認と名前照合を行う。
 *
 * 以下の 2 点を検証する:
 *   1. employeeId が研修生マスタに存在するか
 *   2. フロントから送られた name がマスタの名前と一致するか
 *
 * 問題があればエラーメッセージ文字列を返す。
 * 問題なければ null を返す。
 * ※ null が「エラーなし」を意味する（validateCommonFields と同じ設計）。
 *
 * @param {string} spreadsheetId
 * @param {string} employeeId  フロントから送られた研修生ID
 * @param {string} name        フロントから送られた名前
 * @returns {string|null}  エラーメッセージ または null
 */
function validateTraineeMaster(spreadsheetId, employeeId, name) {
  const trainee = getTraineeById(spreadsheetId, employeeId);

  // 研修生IDがマスタに存在しない
  if (!trainee) {
    return `研修生ID「${employeeId}」は登録されていません`;
  }

  // フロントから送られた名前とマスタの名前を照合する
  // trim() で前後の空白を除いてから比較する
  if (trainee.name.trim() !== name.trim()) {
    return `氏名が一致しません（登録名: ${trainee.name}）`;
  }

  return null; // エラーなし
}

/**
 * 研修生マスタのステータス列（C列）を更新する。
 *
 * clockIn 後に「出勤中」、clockOut 後に「退勤済み」を書き込むために使う。
 *
 * 打刻記録への書き込みは既に完了した後にこの関数が呼ばれるため、
 * ステータス更新に失敗しても打刻は取り消さない。
 * 失敗した場合は Logger.log にエラーを記録するだけで、例外を外へ投げない。
 *
 * @param {string} spreadsheetId
 * @param {string} employeeId
 * @param {string} status  書き込むステータス文字列（例: "出勤中", "退勤済み"）
 */
function updateTraineeStatus(spreadsheetId, employeeId, status) {
  try {
    const sheet     = getTraineeMasterSheet(spreadsheetId);
    const targetRow = findTraineeRowById(sheet, employeeId);

    if (!targetRow) {
      // バリデーション済みのはずなので通常はここに来ない
      Logger.log(`[updateTraineeStatus] 研修生ID「${employeeId}」が見つかりませんでした`);
      return;
    }

    // C列（ステータス）を上書きする
    sheet.getRange(targetRow, COL_MASTER_STATUS).setValue(status);
    Logger.log(`[updateTraineeStatus] ID=${employeeId} のステータスを「${status}」に更新しました`);

  } catch (err) {
    // ステータス更新の失敗はログに残すが、打刻処理には影響させない
    Logger.log(`[updateTraineeStatus] 更新失敗: ${err.message}`);
  }
}

// =====================================================
// 3. 打刻記録シートの操作
// =====================================================

/**
 * 打刻記録シートから「当日・同氏名・退勤時刻が未入力」の行番号を探して返す。
 *
 * clockOut（退勤打刻）のときに使う。
 * 当日の出勤レコードがあって、かつ退勤時刻（E列）が空の行 = 退勤待ちの行。
 *
 * ※ 以前は B列（employeeId）で照合していたが、全員が同じ employeeId("user01")
 *   を持つ運用では別の人の行が誤って更新されてしまう。
 *   氏名（C列）で照合することで「その人の行だけ」を正しく更新できる。
 *
 * 見つからなかった場合は null を返す（呼び出し側でエラーを返す）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet  打刻記録シート
 * @param {string} name     氏名（C列の値と照合する）
 * @param {string} todayStr 今日の日付文字列 "YYYY/MM/DD"
 * @returns {number|null}  見つかった行番号（1 始まり）または null
 */
function findTodayOpenAttendanceRow(sheet, name, todayStr) {
  const lastRow = sheet.getLastRow();

  // データが 1 行もない（ヘッダーのみ）場合は即 null
  if (lastRow < 2) return null;

  // 2 行目（ヘッダーの次）から最終行まで A〜E 列を一括取得する
  // getRange().getValues() は 2 次元配列を返す: [[row2], [row3], ...]
  const values = sheet.getRange(2, 1, lastRow - 1, COL_CLOCK_OUT).getValues();

  for (let i = 0; i < values.length; i++) {
    const row         = values[i];
    const rowDate     = String(row[COL_DATE      - 1]); // A列（配列は 0 始まり）
    const rowName     = String(row[COL_NAME      - 1]); // C列: 氏名で照合する
    const rowClockOut =        row[COL_CLOCK_OUT - 1];  // E列

    // スプレッドシートから読んだ日付は Date オブジェクトになることがあるため
    // formatDateJST で統一した文字列に変換してから比較する
    const rowDateStr = (rowDate instanceof Date || (!rowDate.startsWith("20")))
      ? formatDateJST(new Date(rowDate))
      : rowDate.slice(0, 10).replace(/-/g, "/"); // "2026-03-17" → "2026/03/17"

    const isToday         = rowDateStr === todayStr;
    const isSamePerson    = rowName    === name;      // ← 氏名で照合
    const isClockOutEmpty = rowClockOut === "" || rowClockOut === null;

    if (isToday && isSamePerson && isClockOutEmpty) {
      // sheet.getRange の行番号は 1 始まり、かつヘッダー行を除いているので +2
      return i + 2;
    }
  }

  return null; // 対象行なし
}

/**
 * 当日の打刻状態（出勤時刻・退勤時刻）を氏名で検索して返す。
 *
 * getStatus アクション（状態確認 API）から呼ばれる。
 * 氏名入力後に「今日すでに出勤しているか」をフロントエンドが確認するために使う。
 *
 * @param {string} spreadsheetId
 * @param {string} name      氏名
 * @returns {{ clockInTime: string|null, clockOutTime: string|null }}
 */
function getTodayStatusByName(spreadsheetId, name) {
  const sheet    = getSheet(spreadsheetId, SHEET_NAME_ATTENDANCE);
  const todayStr = formatDateJST(now());
  const lastRow  = sheet.getLastRow();

  if (lastRow < 2) return { clockInTime: null, clockOutTime: null };

  const values = sheet.getRange(2, 1, lastRow - 1, COL_CLOCK_OUT).getValues();

  // 最新の行を優先するため、末尾から検索する
  for (let i = values.length - 1; i >= 0; i--) {
    const row     = values[i];
    const rowDate = row[COL_DATE - 1];
    const rowName = String(row[COL_NAME - 1]);

    // 日付を文字列に統一して比較
    const rowDateStr = (rowDate instanceof Date)
      ? formatDateJST(rowDate)
      : String(rowDate).startsWith("20")
        ? String(rowDate).slice(0, 10).replace(/-/g, "/")
        : formatDateJST(new Date(rowDate));

    if (rowDateStr !== todayStr || rowName !== name) continue;

    // 一致した行の出勤・退勤時刻を取得する
    // getValue() は時刻を Date オブジェクトで返すことがあるので formatTimeJST で変換
    const inRaw  = row[COL_CLOCK_IN  - 1];
    const outRaw = row[COL_CLOCK_OUT - 1];

    const clockInTime  = inRaw  instanceof Date ? formatTimeJST(inRaw)
                       : (inRaw  && String(inRaw).trim())  ? String(inRaw).trim()  : null;
    const clockOutTime = outRaw instanceof Date ? formatTimeJST(outRaw)
                       : (outRaw && String(outRaw).trim()) ? String(outRaw).trim() : null;

    return { clockInTime, clockOutTime };
  }

  return { clockInTime: null, clockOutTime: null }; // 当日の打刻なし
}

/**
 * 打刻記録シートに出勤レコードを新規追加（末尾に 1 行 append）する。
 *
 * clockIn（出勤打刻）のときに呼ばれる。
 *
 * @param {string} spreadsheetId
 * @param {{ employeeId: string, name: string }} data  フロントから受け取ったデータ
 * @param {Date}   clockInDate  出勤打刻の日時（Date オブジェクト）
 * @returns {{ clockInTime: string }}  記録した出勤時刻（通知メッセージ構築に使う）
 * @throws {Error} シート取得失敗時
 */
function appendAttendanceRow(spreadsheetId, data, clockInDate) {
  const sheet       = getSheet(spreadsheetId, SHEET_NAME_ATTENDANCE);
  const todayStr    = formatDateJST(clockInDate);
  const clockInTime = formatTimeJST(clockInDate);

  // appendRow は最終行の次の行にデータを追加する
  // 列の順番は COL_* の定数と合わせる（A〜F 列）
  sheet.appendRow([
    todayStr,        // A: 日付
    data.employeeId, // B: 研修生ID
    data.name,       // C: 指名
    clockInTime,     // D: 打刻時刻（出勤）
    "",              // E: 退勤時刻（未入力）
    "",              // F: 勤務時間（未計算）
  ]);

  return { clockInTime };
}

/**
 * 打刻記録シートの既存行に退勤時刻と勤務時間を書き込む。
 *
 * clockOut（退勤打刻）のときに呼ばれる。
 * findTodayOpenAttendanceRow() で見つけた行番号に対してセルを更新する。
 *
 * @param {string} spreadsheetId
 * @param {{ employeeId: string, name: string }} data
 * @param {Date}   clockOutDate  退勤打刻の日時
 * @returns {{ clockInTime: string, clockOutTime: string, workMinutes: number, workDuration: string }}
 * @throws {Error} 出勤レコードが見つからない / 退勤時刻が出勤より前 の場合
 */
function updateAttendanceClockOut(spreadsheetId, data, clockOutDate) {
  const sheet        = getSheet(spreadsheetId, SHEET_NAME_ATTENDANCE);
  const todayStr     = formatDateJST(clockOutDate);
  const clockOutTime = formatTimeJST(clockOutDate);

  // 当日・同氏名・退勤未入力の行を検索（氏名で照合することで他人の行を誤更新しない）
  const targetRow = findTodayOpenAttendanceRow(sheet, data.name, todayStr);

  if (!targetRow) {
    // 出勤レコードが存在しないか、すでに退勤済み
    throw new Error("出勤記録が見つかりません。先に出勤打刻を行ってください。");
  }

  // D列（打刻時刻 = 出勤時刻）を取得して勤務時間を計算する
  //
  // ※ getValue() はスプレッドシートが "09:00" を時刻型に変換した場合に
  //   Date オブジェクト（例: Mon Dec 30 1899 09:00:00 GMT+0900）を返す。
  //   String(Date) は長い日付文字列になり calcWorkMinutes が NaN を返すため、
  //   必ず Utilities.formatDate で "HH:mm" 文字列に変換してから渡す。
  const clockInRaw  = sheet.getRange(targetRow, COL_CLOCK_IN).getValue();
  const clockInTime = (clockInRaw instanceof Date)
    ? Utilities.formatDate(clockInRaw, "Asia/Tokyo", "HH:mm")
    : String(clockInRaw).trim();

  const workMinutes = calcWorkMinutes(clockInTime, clockOutTime);

  if (isNaN(workMinutes) || workMinutes <= 0) {
    throw new Error("退勤時刻が出勤時刻より前になっています（または時刻の読み取りに失敗しました）。");
  }

  // E列（退勤時刻）と F列（勤務時間）を書き込む
  sheet.getRange(targetRow, COL_CLOCK_OUT).setValue(clockOutTime);
  sheet.getRange(targetRow, COL_WORK_MINUTES).setValue(workMinutes);

  return {
    clockInTime:  String(clockInTime),
    clockOutTime,
    workMinutes,
    workDuration: formatWorkDuration(workMinutes),
  };
}

// =====================================================
// 4. 課題完了記録シートの操作
// =====================================================

/**
 * 課題完了記録シートに 1 行追記する。
 *
 * completeTask（課題完了報告）のときに呼ばれる。
 * 既存行の更新ではなく、必ず末尾に新規追加する。
 *
 * 列構成:
 *   A: 完了日時 / B: 研修生ID / C: 指名 / D: アプリURL / E: 判定（初期値: "未確認"）
 *
 * @param {string} spreadsheetId
 * @param {{ employeeId: string, name: string, appUrl: string }} data
 * @param {Date}   reportDate  報告日時
 * @returns {{ reportedAt: string }}  記録した日時文字列
 * @throws {Error} シート取得失敗時
 */
function appendTaskRow(spreadsheetId, data, reportDate) {
  const sheet      = getSheet(spreadsheetId, SHEET_NAME_TASK);
  const reportedAt = formatDateTimeJST(reportDate);

  sheet.appendRow([
    reportedAt,      // A: 完了日時
    data.employeeId, // B: 研修生ID
    data.name,       // C: 指名
    data.appUrl,     // D: アプリURL
    "未確認",        // E: 判定（初期値）
  ]);

  return { reportedAt };
}
