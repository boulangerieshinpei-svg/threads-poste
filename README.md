# threads-poster — Threads自動営業ツール

パン屋の卸クライアント開拓（カフェ・ホテル・飲食店）のための Threads 半自動投稿ツール。

**仕込み中にスマホで写真とひとことを放り込む → 翌朝、整った投稿として自動で出る**

## 構成

- `web/index.html` — 管理画面（単一HTML、ビルド工程なし）
- `functions/` — Cloud Functions（文案生成・定時投稿・トークンリフレッシュ）※フェーズ2以降
- `docs/REQUIREMENTS.md` — 要件定義書（フェーズ別）

## セットアップ（フェーズ1）

1. [Firebase コンソール](https://console.firebase.google.com/)でプロジェクト作成
   - Realtime Database を有効化
   - Storage を有効化
2. プロジェクト設定 → マイアプリ → ウェブアプリを追加し、`firebaseConfig` を取得
3. `web/index.html` 冒頭の `FIREBASE_CONFIG` を自分の値に書き換える
4. `web/index.html` を Firebase Hosting か任意の場所に配置（ローカルで開いてもOK）

### セキュリティルール（開発初期用）

Realtime Database（本番前に認証を入れて締めること）:

```json
{
  "rules": {
    "posts": { ".read": true, ".write": true }
  }
}
```

Storage（画像はThreads APIに公開URLで渡すため読み取り公開が必要）:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /photos/{file} {
      allow read: if true;
      allow write: if true; // 本番前に認証を入れて締めること
    }
  }
}
```

## フェーズ進行

| フェーズ | 内容 | 状態 |
|---|---|---|
| 1 | 投稿ストック管理画面 | 実装済み |
| 2 | AI文案生成（Cloud Functions + Anthropic API） | 未着手 |
| 3 | 定時自動投稿（Cloud Scheduler + Threads API） | 未着手 |
| 4 | トークン自動リフレッシュ | 未着手 |
| 5 | インサイト週次レポート | 未着手 |
