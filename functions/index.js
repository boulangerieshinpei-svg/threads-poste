"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const Anthropic = require("@anthropic-ai/sdk");
const admin = require("firebase-admin");

admin.initializeApp();

const VOICE_PROMPT = readFileSync(path.join(__dirname, "prompts", "voice.md"), "utf8");

// フェーズ2: メモ1行＋カテゴリ → Threads向け文案（Anthropic APIプロキシ）
// APIキーはフロントに置かず、functions/.env の ANTHROPIC_API_KEY のみで扱う
exports.generateCaption = onRequest(
  { region: "us-central1", cors: true, timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "POSTのみ対応しています" });
      return;
    }
    const { memo, category } = req.body || {};
    if (!memo || typeof memo !== "string" || memo.length > 500) {
      res.status(400).json({ error: "memo（500字以内）が必要です" });
      return;
    }

    try {
      // 管理画面で保存された口調設定と、★が付いた投稿（お手本）を反映する
      const [voiceSnap, postsSnap] = await Promise.all([
        admin.database().ref("voice/custom").get(),
        admin.database().ref("posts").get(),
      ]);
      const customVoice = String(voiceSnap.val() || "").trim();
      const favorites = [];
      postsSnap.forEach((child) => {
        const p = child.val();
        if (p.favorite && p.text) favorites.push(p);
      });
      favorites.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const examples = favorites
        .slice(0, 3)
        .map((p, i) => `【お手本${i + 1}】\n${p.text}`)
        .join("\n\n");

      let systemText = VOICE_PROMPT;
      if (examples) {
        systemText += `\n\n## 本人が「良い」と印を付けた投稿の実例（この雰囲気に寄せること）\n${examples}`;
      }
      if (customVoice) {
        systemText += `\n\n## 追加の口調・キャラ指示（本人による設定。最優先で必ず従うこと）\n${customVoice}`;
      }
      console.log(
        `voice設定: ${customVoice ? JSON.stringify(customVoice.slice(0, 80)) : "(なし)"} / お手本: ${favorites.length}件`
      );

      const client = new Anthropic();
      const response = await client.beta.messages.create({
        model: "claude-opus-5",
        max_tokens: 3000,
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [
          { type: "text", text: systemText, cache_control: { type: "ephemeral" } },
        ],
        messages: [
          {
            role: "user",
            content: `カテゴリ: ${category || "指定なし"}\nメモ: ${memo}`,
          },
        ],
      });

      if (response.stop_reason === "refusal") {
        res.status(502).json({ error: "文案を生成できませんでした。メモを変えて再試行してください" });
        return;
      }

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();

      if (!text) {
        res.status(502).json({ error: "空の文案が返されました。再試行してください" });
        return;
      }

      res.json({ text });
    } catch (err) {
      console.error("generateCaption failed:", err);
      res.status(500).json({ error: "生成に失敗しました: " + (err.message || "不明なエラー") });
    }
  }
);

// ===================== フェーズ3: 定時自動投稿 =====================

const THREADS_API = "https://graph.threads.net/v1.0";

// トークンは RTDB の config/threads を優先し、なければ .env の値を使う
// （フェーズ4の週次リフレッシュが RTDB 側を更新し続ける）
async function getThreadsAuth() {
  const snap = await admin.database().ref("config/threads").get();
  const saved = snap.val() || {};
  const accessToken = saved.accessToken || process.env.THREADS_ACCESS_TOKEN;
  const userId = saved.userId || process.env.THREADS_USER_ID;
  if (!accessToken || !userId) {
    throw new Error("Threadsのトークン未設定（functions/.env の THREADS_ACCESS_TOKEN / THREADS_USER_ID）");
  }
  return { accessToken, userId };
}

async function threadsPost(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Threads API ${res.status}: ${JSON.stringify(data.error || data)}`);
  }
  return data;
}

// 画像コンテナは処理完了を待ってから公開する
async function waitForContainer(creationId, accessToken) {
  for (let i = 0; i < 10; i++) {
    const res = await fetch(
      `${THREADS_API}/${creationId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`
    );
    const data = await res.json().catch(() => ({}));
    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR") throw new Error("コンテナ処理がERRORになりました");
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("コンテナ処理が時間内に完了しませんでした");
}

// 2段階投稿: コンテナ作成 → 公開。Threads投稿IDを返す
async function publishToThreads(post, auth) {
  const params = { access_token: auth.accessToken, text: post.text || "" };
  if (post.imageUrl) {
    params.media_type = "IMAGE";
    params.image_url = post.imageUrl;
  } else {
    params.media_type = "TEXT";
  }

  const container = await threadsPost(`${THREADS_API}/${auth.userId}/threads`, params);
  if (post.imageUrl) {
    await waitForContainer(container.id, auth.accessToken);
  }
  const published = await threadsPost(`${THREADS_API}/${auth.userId}/threads_publish`, {
    access_token: auth.accessToken,
    creation_id: container.id,
  });
  return published.id;
}

// 毎日 7:00 / 12:00 / 19:00 JST に、承認済みで予定時刻が到来している先頭1件を投稿
exports.publishScheduled = onSchedule(
  { schedule: "0 7,12,19 * * *", timeZone: "Asia/Tokyo", region: "us-central1", timeoutSeconds: 300 },
  async () => {
    const db = admin.database();
    const now = Date.now();

    const snap = await db.ref("posts").get();
    const due = [];
    snap.forEach((child) => {
      const p = child.val();
      if (p.status === "approved" && p.scheduledAt && p.scheduledAt <= now) {
        due.push({ key: child.key, ...p });
      }
    });
    if (due.length === 0) {
      console.log("投稿対象なし（承認済みで予定時刻到来のものがない）");
      return;
    }
    due.sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
    const post = due[0];

    if (process.env.DRY_RUN === "true") {
      console.log("[DRY_RUN] 実投稿せずpayloadのみ出力:", JSON.stringify({
        key: post.key,
        text: post.text,
        imageUrl: post.imageUrl || null,
        scheduledAt: new Date(post.scheduledAt).toISOString(),
      }, null, 2));
      return;
    }

    const auth = await getThreadsAuth();
    try {
      let threadsPostId;
      try {
        threadsPostId = await publishToThreads(post, auth);
      } catch (firstErr) {
        console.warn("投稿失敗、1回リトライします:", firstErr.message);
        threadsPostId = await publishToThreads(post, auth);
      }
      await db.ref(`posts/${post.key}`).update({
        status: "published",
        threadsPostId,
        publishedAt: Date.now(),
        lastError: null,
      });
      console.log(`投稿成功: ${post.key} -> ${threadsPostId}`);
    } catch (err) {
      console.error(`投稿失敗（リトライ含む）: ${post.key}`, err);
      await db.ref(`posts/${post.key}`).update({
        status: "error",
        lastError: String(err.message || err).slice(0, 500),
      });
    }
  }
);

// ===================== フェーズ4: トークン自動リフレッシュ =====================

// 週1回、長期トークン（60日有効）を更新して RTDB に保存
exports.refreshToken = onSchedule(
  { schedule: "0 4 * * 1", timeZone: "Asia/Tokyo", region: "us-central1" },
  async () => {
    const auth = await getThreadsAuth();
    const res = await fetch(
      `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(auth.accessToken)}`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      console.error("トークンリフレッシュ失敗:", JSON.stringify(data));
      throw new Error("トークンリフレッシュ失敗");
    }
    const expiresAt = Date.now() + (data.expires_in || 0) * 1000;
    await admin.database().ref("config/threads").update({
      accessToken: data.access_token,
      userId: auth.userId,
      expiresAt,
      refreshedAt: Date.now(),
    });
    // 管理画面表示用（公開読み取り可の場所に期限だけ置く）
    await admin.database().ref("config/public/tokenExpiresAt").set(expiresAt);
    console.log(`トークン更新成功。有効期限: ${new Date(expiresAt).toISOString()}`);
  }
);
