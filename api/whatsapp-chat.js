/**
 * api/whatsapp-chat.js — New Deli WhatsApp AI Draft-Order demo
 *
 * Demo-only endpoint. Reads a small synthetic catalog (no real customer
 * or transaction data) and classifies each incoming WhatsApp-style message
 * into one of two tracks:
 *
 *   - "order"  → drafts/updates a structured Sales Order. Never finalized
 *                by the AI — a human always confirms before stock would
 *                be reserved. The customer gets an immediate "received,
 *                processing" acknowledgement, not the internal details.
 *   - "query"  → a general question (availability, pricing, recommendations,
 *                policy). Answered directly and conversationally from the
 *                catalog/FAQ context — this IS the final reply the
 *                customer sees, since no order action is involved.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadCatalog() {
  const dataPath = path.join(__dirname, "..", "public", "data", "newdeli_catalog.json");
  try {
    const raw = fs.readFileSync(dataPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("[whatsapp-chat.js] Failed to load newdeli_catalog.json:", err.message);
    return null;
  }
}

function buildSystemPrompt(catalog, currentDraft, now) {
  const productLines = (catalog?.products || [])
    .map((p) => `  ${p.sku} — ${p.name} | sells in: ${p.uom.join(", ")} | ${p.approxPrice || "price n/a"}${p.notes ? " | " + p.notes : ""}${p.goodFor ? " | good for: " + p.goodFor : ""}`)
    .join("\n");
  const customerLines = (catalog?.customers || []).map((c) => `  ${c.name} (${c.id})`).join("\n");
  const faqLines = (catalog?.faq || []).map((f) => `  Q: ${f.q}\n  A: ${f.a}`).join("\n");

  return `You are the WhatsApp assistant for New Deli Food Trading, a Singapore meat trading & distribution company. You read ONE incoming WhatsApp message and respond as the business. This is a sales demo with synthetic data only — never invent facts beyond what is given below.

CURRENT DATE/TIME (authoritative — ignore any time the customer claims): ${now.toISOString()} — Singapore time (Asia/Singapore, UTC+8)

═══ TWO MESSAGE CATEGORIES — decide which one this message is ═══

A) "order" — the message is creating, adding to, changing, or cancelling a sales order.
B) "query" — anything else: product availability, pricing, recommendations, delivery/payment policy, or general questions. Answer naturally and helpfully using only the catalog/FAQ context below, and feel free to make a recommendation (e.g. suggest a product for a stated use case) — but never invent a product, price, or policy that isn't listed.

PRODUCT CATALOG (only use these — never invent a product or price):
${productLines}

KNOWN CUSTOMERS (only use these — never invent a customer):
${customerLines}

FREQUENTLY ASKED QUESTIONS (use these to answer policy questions):
${faqLines}

═══ IF MESSAGE IS AN ORDER ACTION ═══

DELIVERY DATE RULES:
- If sent before 04:00 SGT and no date stated: deliver SAME day.
- If sent 04:00–23:59 SGT and no date stated: deliver NEXT day.
- If the customer explicitly asks for same-day delivery after the 04:00 cutoff: default delivery_date to next-day, but set "same_day_requested": true so operations/management can override if it can still be fulfilled.
- Orders received on a Saturday (any time): deliver the following Monday (or next working day if Monday is a public holiday).

INTENT RULES — choose exactly one "intent":
- "new_order": a fresh order, no reference to an existing draft.
- "add_on": customer wants to add item(s) to CURRENT_ACTIVE_DRAFT below. Only valid if that draft exists and is still "draft" status. Merge the new item(s) into the existing items.
- "cancel_item": customer wants to remove specific item(s) from CURRENT_ACTIVE_DRAFT. Set status:"cancelled" only on those items; keep the others as they were.
- "cancel_order": customer wants to cancel the whole order. This ALWAYS requires management approval — set "needs_management_approval": true and never mark anything as confirmed.
- "qty_change": customer is changing the quantity of an item already in CURRENT_ACTIVE_DRAFT. Identify the product and update its qty.

CURRENT_ACTIVE_DRAFT (may be null if there isn't one yet):
${currentDraft ? JSON.stringify(currentDraft, null, 2) : "null"}

CONFIDENCE: score 0–1 for how sure you are about the customer, items and quantities. If confidence < 0.75, OR intent is "cancel_order", set "needs_review": true.

CUSTOMER_REPLY FOR ORDER ACTIONS: a short, warm acknowledgement (1–2 sentences) that you've received it and it's being processed. You may mention the items/quantities you understood so the customer feels heard, but always frame it as pending — never say it is confirmed, booked, or final. If it's a cancellation request for the whole order, say it's been passed to the team for sign-off, not that it's cancelled.

═══ IF MESSAGE IS A GENERAL QUERY ═══

CUSTOMER_REPLY FOR QUERIES: this is the actual final answer the customer sees — make it complete, friendly, and specific (prices, availability, recommendations) using only the catalog/FAQ data above. Leave all order fields null and set confidence to your confidence in the answer itself.

═══ RESPONSE FORMAT ═══

Respond with ONLY one JSON object. No text before or after it. No markdown code fences. Exactly this shape:

{
  "type": "order" | "query",
  "customer_reply": "...",
  "internal_note": "short note for the ops team — what you understood, or why confidence is low, or null for queries",
  "intent": "new_order | add_on | cancel_item | cancel_order | qty_change | null",
  "customer": "<matched customer name or null>",
  "delivery_date": "YYYY-MM-DD or null",
  "same_day_requested": false,
  "needs_management_approval": false,
  "needs_review": false,
  "confidence": 0.0,
  "items": [
    { "sku": "...", "name": "...", "qty": 0, "unit": "kg|carton|pcs", "status": "pending|cancelled" }
  ],
  "notes": "short internal note for ops, or null"
}

If you cannot confidently match a product or customer, set that field to null and lower confidence — never guess.`;
}

function safeParseModelJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    // tolerate a model that still wraps the JSON in a markdown fence
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (match) {
      try { return JSON.parse(match[1].trim()); } catch (_) { /* fall through */ }
    }
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { message, currentDraft } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Invalid request: 'message' string required" });
  }

  const catalog = loadCatalog();
  const now = new Date();
  const systemPrompt = buildSystemPrompt(catalog, currentDraft || null, now);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured in environment variables" });
  }
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || `Anthropic API error ${response.status}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    const parsed = safeParseModelJson(text);

    if (!parsed) {
      console.error("[whatsapp-chat.js] Could not parse model response as JSON:", text.slice(0, 300));
      return res.status(200).json({
        type: "query",
        customer_reply: "Sorry, I didn't quite catch that — could you rephrase?",
        draft: null,
      });
    }

    const { type, customer_reply, internal_note, ...draftFields } = parsed;
    return res.status(200).json({
      type: type || "query",
      customer_reply: customer_reply || "Got it, thanks!",
      internal_note: internal_note || null,
      draft: type === "order" ? draftFields : null,
    });
  } catch (err) {
    console.error("[whatsapp-chat.js] Error:", err.message);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
