/** Realistic sample Holocrons for NEXT_PUBLIC_API_MOCK=1. Same shape as the skill JSON contract (Notion page 03). */
import { countGuardrails, type SkillDetail, type SkillJson } from "./skills";

function detail(json: SkillJson, extra: { status: "draft" | "published"; domain: string; published_at: string | null }): SkillDetail {
  return {
    ...json, ...extra, steps_count: json.steps.length, guardrails_count: countGuardrails(json),
  };
}

const day = 86_400_000;

export function seedSkills(now = Date.now()): SkillDetail[] {
  const iso = (ago: number) => new Date(now - ago).toISOString();

  const invoices = detail(
    {
      id: "skill-invoices",
      title: "Process supplier invoices before month-end",
      description:
        "How Sabine codes and posts supplier invoices in SandboxERP before the month-end close. Covers cost center choice (opex versus capex), asset numbers and what to do with unknown suppliers.",
      author: { id: "u-sabine", name: "Sabine" },
      created_at: iso(2 * day),
      language: "en",
      steps: [
        {
          idx: 1,
          title: "Open the invoice in the queue",
          screen_moment: { t_ms: 24_000, description: "Invoice queue, invoice 4471 highlighted" },
          decision: { type: "routine", summary: "Picked the oldest unposted invoice first" },
          reason: { text: "Oldest first keeps early payment discounts alive.", quote: "I always take the oldest one, the discount window closes first.", t_ms: 26_000 },
          guardrails: [],
          predict_prompt: "Three invoices are waiting. Which one do you open first, and why?",
        },
        {
          idx: 2,
          title: "Check the supplier against the master list",
          screen_moment: { t_ms: 71_000, description: "Supplier field, master data side panel open" },
          decision: { type: "judgment", summary: "Confirmed the supplier exists and the bank details match" },
          reason: { text: "A changed bank account is the classic fraud signal.", quote: "If the IBAN differs from the master data, I do not touch it.", t_ms: 76_000 },
          guardrails: [
            { id: "g2", type: "stop_and_ask", rule: "Unknown supplier or changed IBAN: stop and ask the controller", quote: "Unknown supplier, I stop and call the controller, every time.", t_ms: 84_000 },
          ],
          predict_prompt: "The IBAN on the invoice differs from the master data. What do you do?",
        },
        {
          idx: 3,
          title: "Code the invoice to a cost center",
          screen_moment: { t_ms: 192_000, description: "Invoice 4471, cost center field" },
          decision: { type: "judgment", summary: "Re-coded from opex 4711 to capex 0400" },
          reason: { text: "Equipment over 5000 EUR is always capex.", quote: "Equipment over five thousand is always capex.", t_ms: 195_000 },
          guardrails: [
            { id: "g3", type: "limit", rule: "No asset number, no capex booking", quote: "Without an asset number the booking bounces in audit.", t_ms: 201_000 },
          ],
          predict_prompt: "Invoice is for a 7,200 EUR compressor. Which cost center?",
        },
        {
          idx: 4,
          title: "Enter the asset number",
          screen_moment: { t_ms: 236_000, description: "Asset no. field next to the cost center" },
          decision: { type: "routine", summary: "Copied the asset number from the purchase order" },
          reason: { text: "The purchase order is the only trusted source for asset numbers.", quote: "Never invent one, it comes from the purchase order.", t_ms: 239_000 },
          guardrails: [],
        },
        {
          idx: 5,
          title: "Post and confirm",
          screen_moment: { t_ms: 301_000, description: "Post button, confirmation dialog 'Confirm posting?'" },
          decision: { type: "judgment", summary: "Held the posting for a supplier who double-billed" },
          reason: { text: "December double-billing is common, so a held invoice is checked first.", quote: "In December some suppliers bill twice, I hold those and compare.", t_ms: 305_000 },
          guardrails: [
            { id: "g5", type: "stop_and_ask", rule: "Same amount and supplier already posted this month: hold and ask", quote: "Same amount, same supplier, same month: I hold it.", t_ms: 312_000 },
          ],
          predict_prompt: "The same amount from the same supplier was posted last week. Do you post?",
        },
      ],
      global_guardrails: [
        { id: "gg1", type: "limit", rule: "Never post after the close deadline without approval", quote: "After the deadline nothing goes in without my boss.", t_ms: 340_000 },
      ],
      teachback: { confirmed: true, corrections: ["Hold applies to all suppliers who double-bill in December"] },
    },
    { status: "published", domain: "Finance", published_at: iso(day) },
  );

  const vendor = detail(
    {
      id: "skill-vendor",
      title: "Onboard a new vendor",
      description:
        "Marc's checklist for creating a vendor in the procurement system: tax ID check, payment terms and the compliance questionnaire.",
      author: { id: "u-marc", name: "Marc" },
      created_at: iso(5 * day),
      language: "en",
      steps: [
        {
          idx: 1,
          title: "Verify the tax ID",
          screen_moment: { t_ms: 40_000, description: "Vendor form, tax ID field and the registry lookup tab" },
          decision: { type: "judgment", summary: "Looked the tax ID up in the official registry before saving" },
          reason: { text: "Fake vendors almost always have a tax ID that does not resolve.", quote: "If the registry does not know the number, nothing else matters.", t_ms: 44_000 },
          guardrails: [
            { id: "g1", type: "stop_and_ask", rule: "Tax ID not found in the registry: stop and ask compliance", quote: "Not found means I stop and ask compliance.", t_ms: 52_000 },
          ],
          predict_prompt: "The registry shows no match for the tax ID. Next move?",
        },
        {
          idx: 2,
          title: "Set the payment terms",
          screen_moment: { t_ms: 118_000, description: "Payment terms dropdown set to 30 days net" },
          decision: { type: "routine", summary: "Chose 30 days net, the company default" },
          reason: { text: "Anything other than the default needs a signed exception.", quote: "Thirty days net unless procurement signed something else.", t_ms: 121_000 },
          guardrails: [
            { id: "g2", type: "limit", rule: "Terms above 60 days need a signed exception", quote: "Above sixty days I need the signed form.", t_ms: 130_000 },
          ],
        },
        {
          idx: 3,
          title: "Send the compliance questionnaire",
          screen_moment: { t_ms: 190_000, description: "Compliance tab, send questionnaire button" },
          decision: { type: "routine", summary: "Sent the standard questionnaire by email" },
          reason: { text: "Vendors stay blocked for payment until it comes back.", quote: "No questionnaire, no payment block release.", t_ms: 194_000 },
          guardrails: [],
        },
      ],
      global_guardrails: [],
      teachback: { confirmed: true, corrections: [] },
    },
    { status: "published", domain: "Procurement", published_at: iso(4 * day) },
  );

  const draft = detail(
    {
      id: "skill-draft-expenses",
      title: "Approve travel expense reports",
      description: "Draft from a session an hour ago. Review the steps, then publish it to the Jedi Archives.",
      author: { id: "admin", name: "Admin" },
      created_at: iso(3_600_000),
      language: "en",
      steps: [
        {
          idx: 1,
          title: "Match receipts to the claimed amount",
          screen_moment: { t_ms: 33_000, description: "Expense report with receipt thumbnails" },
          decision: { type: "judgment", summary: "Rejected a line without a receipt" },
          reason: { text: "Receipts are required above 25 EUR by tax law.", quote: "Over twenty-five euros there must be a receipt, no exceptions.", t_ms: 36_000 },
          guardrails: [
            { id: "g1", type: "limit", rule: "No receipt above 25 EUR, no reimbursement", quote: "No receipt, no money.", t_ms: 41_000 },
          ],
        },
        {
          idx: 2,
          title: "Approve and forward to payroll",
          screen_moment: { t_ms: 95_000, description: "Approve button with the payroll queue on the right" },
          decision: { type: "routine", summary: "Approved the matched report" },
          reason: { text: "Payroll runs on Thursday, so approval before Wednesday noon.", quote: "Approve before Wednesday noon or it waits a week.", t_ms: 99_000 },
          guardrails: [],
        },
      ],
      global_guardrails: [],
    },
    { status: "draft", domain: "Finance", published_at: null },
  );

  return [invoices, vendor, draft];
}
