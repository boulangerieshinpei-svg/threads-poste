"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const Anthropic = require("@anthropic-ai/sdk");

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
      const client = new Anthropic();
      const response = await client.beta.messages.create({
        model: "claude-opus-5",
        max_tokens: 3000,
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [
          { type: "text", text: VOICE_PROMPT, cache_control: { type: "ephemeral" } },
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
