# CLAUDE.md — Threads自動投稿ツール

## プロジェクト概要
パン屋の自社Threadsアカウントの発信を半自動化するツール。
スマホから投稿ネタ（写真＋ひとこと）を放り込むと、AIが文面を整え、定時に自動投稿される。

## 構成
- `web/index.html` — 管理画面（単一HTMLファイル。ビルド工程なし）
- `functions/` — Cloud Functions（定時投稿・トークンリフレッシュ・文案生成プロキシ）
- `docs/REQUIREMENTS.md` — 要件定義書（フェーズ別）

## 技術スタック
- フロント: 単一HTML + vanilla JS（WEBREADと同方式。フレームワーク不使用）
- DB: Firebase Realtime Database
- 定時実行: Cloud Functions (Node.js) + Cloud Scheduler
- 外部API: Threads API (graph.threads.net), Anthropic API

## 開発ルール
- 1タスク1コミット。タスクは docs/REQUIREMENTS.md のフェーズ単位で進める
- 変更後は必ず検証を行うこと:
  - `grep -c "function " web/index.html` で関数数の増減を確認し、意図しない消失がないかチェック
  - `node --check` で functions 配下の構文チェック
- index.html は関数の丸ごと書き換えを避け、最小差分で編集する
- 秘密情報（App Secret, アクセストークン, Anthropic APIキー）は絶対にフロントに置かない。
  Cloud Functions の環境変数（functions/.env — gitignore済み）でのみ扱う
- Anthropic API はフロントから直接叩かず、必ず Functions 経由のプロキシにする

## Threads API の要点
- 投稿は2段階: POST /{user-id}/threads でコンテナ作成 → creation_id を受け取り
  POST /{user-id}/threads_publish で公開
- 長期アクセストークンは60日で失効。GET /refresh_access_token で
  失効前に自動リフレッシュする（Scheduler で週1実行、残り日数をDBに記録）
- 画像投稿は公開URLが必要 → Firebase Storage にアップロードしてURLを渡す

## UI方針
- スマホファースト（主にiPhoneで深夜に操作する）
- confirm() は使わない（iPhoneで動作しない既知問題）→ カスタムモーダル askConfirm を使う
- 入力は最小限: 写真1枚＋テキスト1行で投稿ネタとして成立すること

## テスト
- Threads側にテスト用の下書き投稿は作れないため、開発中は dry-run フラグで
  APIコール直前の payload をログ出力するのみとし、実投稿は明示指示があった時だけ行う
