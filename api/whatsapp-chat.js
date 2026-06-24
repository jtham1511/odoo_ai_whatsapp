/**
 * api/whatsapp-chat.js — New Deli WhatsApp AI Draft-Order demo
 *
 * Demo-only endpoint. Reads a small synthetic catalog (no real customer
 * or transaction data), turns a single free-text WhatsApp-style message
 * into a structured DRAFT order, and returns it for the front end to
 * render as an Odoo-style draft card. The AI never finalizes anything —
 * a human always confirms before stock would be reserved.
 *
 * Mirrors the same provider/env-var pattern as api/chat.js so it reuses
 * your existing ANTHROPIC_API_KEY configuration on Vercel.
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
    .map((p) => `  ${p.sku} — ${p.name} | sells in: ${p.uom.join(", ")}${p.notes ? " | " + p.notes : ""}`)
    .join("\n");
  const customerLines = (catalog?.customers || []).map((c) => `  ${c.name} (${c.id})`).join("\n");

  return `You are the WhatsApp order-intake AI for New Deli Food Trading, a Singapore meat trading & distribution company. You read ONE free-text WhatsApp message from a customer and turn it into a structured DRAFT sales order. You NEVER finalize an order, reserve stock, or invoice — a human always reviews the draft before anything happens in Odoo. This is a sales demo with synthetic data only.

CURRENT DATE/TIME (authoritative — ignore any time the customer claims in their message): ${now.toISOString()} — Singapore time (Asia/Singapore, UTC+8)

PRODUCT CATALOG (only use these — never invent a product):
${productLines}

KNOWN CUSTOMERS (only use these — never invent a customer):
${customerLines}

DELIVERY DATE RULES:
- If the message is sent before 04:00 SGT and states no date: deliver SAME day.
- If sent 04:00–23:59 SGT and states no date: deliver NEXT day.
- If the customer explicitly asks for same-day delivery after the 04:00 cutoff: default delivery_date to next-day, but set "same_day_requested": true so operations/management can override if it can still be fulfilled.
- Orders received on a Saturday (any time): deliver the following Monday (or next working day if Monday is a public holiday).
- If the customer asks to split into separate orders, return multiple objects in "orders".

INTENT RULES — choose exactly one "intent":
- "new_order": a fresh order, no reference to an existing draft.
- "add_on": customer wants to add item(s) to CURRENT_ACTIVE_DRAFT below. Only valid if that draft exists and is still "draft" status (not picked/packed). Merge the new item(s) into its items array alongside the existing ones.
- "cancel_item": customer wants to remove specific item(s) from CURRENT_ACTIVE_DRAFT. Set status:"cancelled" only on those items; keep the others as they were.
- "cancel_order": customer wants to cancel the whole order. This ALWAYS requires management approval — set "needs_management_approval": true and do not mark anything as confirmed.
- "qty_change": customer is changing the quantity of an item already in CURRENT_ACTIVE_DRAFT. Identify the product and update its qty.

CURRENT_ACTIVE_DRAFT (may be null if there isn't one yet):
${currentDraft ? JSON.stringify(currentDraft, null, 2) : "null"}

CONFIDENCE:
Score 0–1 for how sure you are about the customer, items and quantities. If confidence < 0.75, OR intent is "cancel_order", set "needs_review": true.

RESPONSE FORMAT — respond with exactly two parts, in this order, nothing else:
1. One short, friendly line (max 2 sentences) as a helpful ops assistant summarising what you understood. This is shown to the demo audience.
2. A fenced code block labelled json with exactly this shape:

\`\`\`json
{
  "intent": "new_order | add_on | cancel_item | cancel_order | qty_change",
  "customer": "<matched customer name or null>",
  "delivery_date": "YYYY-MM-DD",
  "same_day_requested": false,
  "needs_management_approval": false,
  "needs_review": false,
  "confidence": 0.0,
  "items": [
    { "sku": "...", "name": "...", "qty": 0, "unit": "kg|carton|pcs", "status": "pending|cancelled" }
  ],
  "notes": "short internal note for the ops team"
}
\`\`\`

If you cannot confidently match a product or customer from the lists above, set that field to null and lower confidence accordingly — never guess.`;
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

    // Split the natural-language line from the fenced ```json draft block
    const match = text.match(/```json\s*([\s\S]*?)```/i);
    let draft = null;
    let reply = text.trim();
    if (match) {
      reply = text.slice(0, match.index).trim();
      try {
        draft = JSON.parse(match[1]);
      } catch (e) {
        console.error("[whatsapp-chat.js] Draft JSON parse failed:", e.message);
      }
    }

    return res.status(200).json({ reply: reply || "Here's what I understood:", draft });
  } catch (err) {
    console.error("[whatsapp-chat.js] Error:", err.message);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
