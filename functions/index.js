"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const Anthropic = require("@anthropic-ai/sdk");
const admin = require("firebase-admin");

admin.initializeApp();

const VOICE_PROMPT = readFileSync(path.join(__dirname, "prompts", "voice.md"), "utf8");

// 「AIっぽさチェック」用の辛口編集者プロンプト
const CRITIQUE_PROMPT = `あなたはSNS文章の辛口編集者。パン屋の店主が書いたことになっているThreads投稿文（卸営業目的）を読み、「AIが書いたっぽく見えないか」を厳しめに判定する。

AIっぽさの典型例（これらを重点的に探す）:
- 「いかがでしょうか」「〜ですよね」などの読者への過剰な呼びかけ
- 「魅力」「こだわり」「まさに」「ぜひ」などの常套句
- 文の長さが均等で、構成が完璧すぎる（人間はもっと崩れる）
- 内容のない形容詞の羅列、体言止めの乱発
- 絵文字・記号の使い方が広告っぽい
- 具体的な数字や固有の事実がなく、誰でも書ける一般論

出力形式（余計な前置きなし）:
AIっぽさ: ★☆☆☆☆〜★★★★★（★が多いほどAIっぽい）＋一言
引っかかる箇所: 実際のフレーズを「」で引用して短く指摘（最大5個。なければ書かない）

★2以下なら「人間の文章として通る」と言い切り、良い点を1つ挙げて終わる。甘い判定はしない。
★3以上なら、指摘のあとに単独行で「---改善版---」と書き、続けて修正した投稿文の完成版だけを出力する（解説なし。本人の口調と内容の事実は保ち、捏造しない）。`;

// フェーズ2: メモ1行＋カテゴリ → Threads向け文案（Anthropic APIプロキシ）
// APIキーはフロントに置かず、functions/.env の ANTHROPIC_API_KEY のみで扱う
exports.generateCaption = onRequest(
  { region: "us-central1", cors: true, timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "POSTのみ対応しています" });
      return;
    }
    const { memo, category, reference, mode } = req.body || {};
    if (!memo || typeof memo !== "string" || memo.length > 600) {
      res.status(400).json({ error: "memo（600字以内）が必要です" });
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

      let systemText;
      let userText;
      if (mode === "critique") {
        // 「AIっぽさチェック」: 文案生成ではなく辛口編集者として判定する
        systemText = CRITIQUE_PROMPT;
        if (examples) {
          systemText += `\n\n## 参考: 本人が「良い」と認めた実際の投稿（この人らしさの基準）\n${examples}`;
        }
        if (customVoice) {
          systemText += `\n\n## 本人の口調・キャラ設定（改善版を書くときはこれに従う）\n${customVoice}`;
        }
        userText = `この投稿文をチェック:\n\n${memo}`;
      } else {
        systemText = VOICE_PROMPT;
        if (examples) {
          systemText += `\n\n## 本人が「良い」と印を付けた投稿の実例（この雰囲気に寄せること）\n${examples}`;
        }
        // 分析タブの「この型で新作を作る」: 反応が良かった投稿を型として踏襲させる
        if (reference && typeof reference === "string" && reference.trim()) {
          systemText += `\n\n## 反応が良かった投稿（今回はこの投稿の構成・型・雰囲気を踏襲し、メモの内容で新作を書くこと。文章のコピーはしない）\n${reference.trim().slice(0, 600)}`;
        }
        if (customVoice) {
          systemText += `\n\n## 追加の口調・キャラ指示（本人による設定。最優先で必ず従うこと）\n${customVoice}`;
        }
        userText = `カテゴリ: ${category || "指定なし"}\nメモ: ${memo}`;
      }
      console.log(
        `mode: ${mode || "generate"} / voice設定: ${customVoice ? JSON.stringify(customVoice.slice(0, 80)) : "(なし)"} / お手本: ${favorites.length}件`
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
          { role: "user", content: userText },
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

      // チェックモードは「判定」と「改善版」を分けて返す（改善版はAIっぽい時のみ付く）
      if (mode === "critique") {
        const parts = text.split(/\n-{2,}\s*改善版\s*-{2,}\s*\n?/);
        const critique = parts[0].trim();
        const improved = (parts[1] || "").trim();
        res.json(improved ? { text: critique, improved } : { text: critique });
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

// ===================== フェーズ5: インサイト収集 =====================

// 毎朝6:30 JSTに、投稿済み（直近60日）のviews/likes等を取得してDBへ保存
exports.fetchInsights = onSchedule(
  { schedule: "30 6 * * *", timeZone: "Asia/Tokyo", region: "us-central1", timeoutSeconds: 300 },
  async () => {
    const auth = await getThreadsAuth();
    const db = admin.database();
    const snap = await db.ref("posts").get();

    const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
    const targets = [];
    snap.forEach((child) => {
      const p = child.val();
      if (p.status === "published" && p.threadsPostId && (p.publishedAt || 0) >= cutoff) {
        targets.push({ key: child.key, id: p.threadsPostId });
      }
    });

    let done = 0;
    for (const t of targets) {
      try {
        const res = await fetch(
          `${THREADS_API}/${t.id}/insights?metric=views,likes,replies,reposts,quotes&access_token=${encodeURIComponent(auth.accessToken)}`
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(JSON.stringify(data.error || data));
        const m = { fetchedAt: Date.now() };
        for (const item of data.data || []) {
          const v =
            (item.values && item.values[0] && item.values[0].value) ??
            (item.total_value && item.total_value.value) ?? 0;
          m[item.name] = v;
        }
        await db.ref(`posts/${t.key}/insights`).set(m);
        done++;
      } catch (e) {
        console.warn(`insights取得失敗 ${t.key}:`, e.message || e);
      }
    }
    console.log(`インサイト更新: ${done}/${targets.length}件`);
  }
);
