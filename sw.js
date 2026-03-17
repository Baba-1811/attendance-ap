/**
 * sw.js
 * Service Worker — PWA のオフラインキャッシュを担当する
 *
 * 戦略: キャッシュファースト
 *   1. リクエストに対してキャッシュに保存済みのレスポンスがあればそれを返す
 *   2. キャッシュになければネットワークに取りに行く
 *
 * GAS への POST はキャッシュしない（通信が必要なリクエストのため）
 *
 * バージョン管理:
 *   CACHE_NAME を変えると古いキャッシュが自動的に削除される
 *   ファイルを更新したら v1 → v2 のようにインクリメントする
 */

const CACHE_NAME = "attendance-app-v2"; // app.js の localStorage 修正に合わせてバージョンアップ

/**
 * キャッシュ対象のファイル一覧
 * アプリを構成する静的ファイルをすべて列挙する
 */
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

/* ============================================================
   install イベント
   Service Worker が初めてインストールされるときに発火する
   ASSETS_TO_CACHE をすべてキャッシュに保存する
   ============================================================ */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  // 古い Service Worker が残っていても即座にこの SW を有効にする
  self.skipWaiting();
});

/* ============================================================
   activate イベント
   新しい Service Worker が有効になるときに発火する
   古いバージョンのキャッシュを削除する
   ============================================================ */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME) // 現在のバージョン以外
          .map((name) => caches.delete(name))     // を削除する
      )
    )
  );
  // すでに開いているページにもすぐこの SW を適用する
  self.clients.claim();
});

/* ============================================================
   fetch イベント
   ページからリクエストが発生するたびに発火する
   GET リクエストにはキャッシュファースト戦略を適用する
   POST（GAS への打刻・報告）はキャッシュしない
   ============================================================ */
self.addEventListener("fetch", (event) => {
  // POST など GET 以外はそのままネットワークへ流す（キャッシュしない）
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // キャッシュがあればそれを返す
      if (cachedResponse) return cachedResponse;

      // キャッシュになければネットワークから取得する
      return fetch(event.request);
    })
  );
});
