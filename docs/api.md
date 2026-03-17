# API 設計書

## 概要

フロントエンド（GitHub Pages）から Google Apps Script（GAS）へ HTTP POST で通信する。
GAS は単一の URL でリクエストを受け取り、`action` フィールドで処理を分岐する。

---

## エンドポイント

```
POST https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec
Content-Type: application/json
```

> `{DEPLOYMENT_ID}` は GAS のデプロイ後に発行される固有 ID に置き換える。

---

## 共通仕様

### リクエストヘッダー

| ヘッダー | 値 |
|----------|----|
| `Content-Type` | `application/json` |

### リクエストボディ 共通フィールド

| フィールド | 型 | 必須 | 説明 |
|------------|----|------|------|
| `action` | string | ✅ | 処理の種類。下表参照 |
| `employeeId` | string | ✅ | 社員番号（例: `EMP001`） |
| `name` | string | ✅ | 氏名（例: `山田 太郎`） |
| `timestamp` | string | ✅ | ISO 8601 形式（例: `2026-03-17T09:00:00+09:00`） |

### レスポンスボディ 共通フィールド

| フィールド | 型 | 説明 |
|------------|----|------|
| `status` | `"ok"` \| `"error"` | 処理結果 |
| `message` | string | ユーザー向けの日本語メッセージ |

---

## action: clockIn（出勤打刻）

### リクエスト

```json
{
  "action": "clockIn",
  "employeeId": "EMP001",
  "name": "山田 太郎",
  "timestamp": "2026-03-17T09:00:00+09:00"
}
```

### レスポンス（成功）

```json
{
  "status": "ok",
  "message": "出勤打刻を記録しました（09:00）"
}
```

### レスポンス（エラー）

| 状況 | message の内容 |
|------|---------------|
| 当日すでに出勤打刻済み | `"すでに出勤打刻済みです"` |
| 必須フィールド不足 | `"リクエストが不正です"` |

---

## action: clockOut（退勤打刻）

### リクエスト

```json
{
  "action": "clockOut",
  "employeeId": "EMP001",
  "name": "山田 太郎",
  "timestamp": "2026-03-17T18:00:00+09:00"
}
```

### レスポンス（成功）

```json
{
  "status": "ok",
  "message": "退勤打刻を記録しました（18:00 / 勤務時間: 9時間0分）"
}
```

### レスポンス（エラー）

| 状況 | message の内容 |
|------|---------------|
| 当日の出勤記録が存在しない | `"出勤記録が見つかりません"` |
| 退勤時刻が出勤時刻より前 | `"退勤時刻が出勤時刻より前になっています"` |
| すでに退勤打刻済み | `"すでに退勤打刻済みです"` |

---

## action: report（課題完了報告）

### リクエスト

```json
{
  "action": "report",
  "employeeId": "EMP001",
  "name": "山田 太郎",
  "task": "○○機能の実装完了",
  "timestamp": "2026-03-17T17:55:00+09:00"
}
```

追加フィールド:

| フィールド | 型 | 必須 | 説明 |
|------------|----|------|------|
| `task` | string | ✅ | 課題内容（最大 200 文字） |

### レスポンス（成功）

```json
{
  "status": "ok",
  "message": "課題報告を送信しました"
}
```

### レスポンス（エラー）

| 状況 | message の内容 |
|------|---------------|
| `task` が空文字 | `"課題内容が空です"` |
| `task` が 200 文字超 | `"課題内容が長すぎます"` |

---

## フロントエンドの fetch 実装イメージ

```javascript
// タイムアウト付き fetch のラッパー
async function postToGAS(body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒でタイムアウト

  try {
    const res = await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return await res.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("タイムアウトしました。時間をおいて再度お試しください");
    }
    throw new Error("通信に失敗しました。ネットワークを確認してください");
  }
}
```

---

## GAS 側の CORS 対応

GAS のウェブアプリは `doPost` の戻り値を `ContentService` で返す必要がある。
`application/json` で返すことで CORS エラーを回避できる。

```javascript
// utils.gs 内のレスポンス生成関数
function createResponse(status, message) {
  const payload = JSON.stringify({ status, message });
  return ContentService
    .createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}
```

> **注意:** GAS のウェブアプリは「アクセスできるユーザー: 全員」に設定しないと
> フロントエンドからアクセスできない。認証が必要な場合は別途検討すること。
