# New Deli — WhatsApp AI Draft-Order Concept Demo

A standalone demo showing how a free-text WhatsApp message can be turned into a
structured draft Sales Order (with a human confirming before anything is final),
and how the same assistant can answer open product/availability questions.

**All data in this repo is synthetic.** No real customer, order, or transaction
data is included — see `public/data/newdeli_catalog.json`.

## How it works

- `public/index.html` — the demo page: a WhatsApp-style phone mock on the left,
  an Odoo-style "Draft Sales Order" panel on the right.
- `api/whatsapp-chat.js` — a Vercel serverless function. Reads the catalog,
  builds a system prompt, and calls the Anthropic API. Classifies every
  incoming message as either:
  - **an order action** (new order / add-on / cancel item / cancel whole
    order / quantity change) → drafted into the Odoo-style panel, with a
    "received, processing" message sent back to the customer immediately,
    and a final confirmation message sent only after a human clicks
    **Confirm & reserve stock**.
  - **a general enquiry** (availability, pricing, recommendations, policy)
    → answered directly from the catalog/FAQ data, no order created.
- `public/data/newdeli_catalog.json` — synthetic products, customers, and FAQ
  entries the assistant is allowed to reference. It will not invent anything
  outside this file.

## Deploy

1. Push this folder to a new GitHub repo (or `vercel` from inside it directly
   with the Vercel CLI — no GitHub needed).
2. Import the repo in the Vercel dashboard, or run `vercel --prod` from this
   folder.
3. In **Project Settings → Environment Variables**, add:
   | Name | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your Anthropic API key |
   | `ANTHROPIC_MODEL` | optional, defaults to `claude-sonnet-4-6` |
   | `ALLOWED_ORIGIN` | optional, defaults to `*` |
4. Redeploy after adding env vars (Vercel only picks them up on the next
   deployment).
5. Open the deployed URL — the demo page is served at the root (`/`).

See `.env.example` for local reference; copy it to `.env` if you want to run
`vercel dev` locally (`vercel env pull` will populate it from your project).

## Live demo script

Click the chips in this order for a clean run-through (each one builds on the
previous draft, so running them out of order — or hitting **Reset demo** in
between — will break the add-on/qty-change/cancel continuity):

1. **New order** — creates the first draft.
2. **Same-day request** — shows the cutoff-time override flag.
3. **Add-on** — merges a new item into the still-open draft.
4. **Qty change** — updates a quantity on the same draft.
5. **Cancel item** — removes one line, keeps the rest.
6. **Cancel whole order** — always routes to "needs manager approval," never
   auto-confirms.

Then, independently of the above (these don't touch the draft):

- **Ask availability** — general product/pricing question.
- **Ask recommendation** — open-ended suggestion based on the catalog.

Click **Reset demo** to clear everything and start over.

## Notes

- This is a sales/concept demo, not a production integration — there's no
  real Odoo, WhatsApp Business API, or database behind it. Confirming an
  order only updates the UI state.
- Each request to `/api/whatsapp-chat` is a live call to the Anthropic API —
  nothing is scripted or pre-recorded.
