# Monthly report AI insights

This function powers the optional AI briefing in the Monthly Reports side panel. It requires an authenticated administrator and verifies that every submitted shop belongs to the administrator's organization. The browser sends only aggregated monthly totals, medicine names with aggregated sales, shop summaries, and transfer candidates. It does not send customer, staff, prescription, or transaction-level records.

For real pharmacy business data, configure a **paid Gemini API project**. Google's unpaid Gemini tier may use submitted content to improve its services and may allow human review.

1. Add the Gemini API key as a Supabase Edge Function secret named `GEMINI_API_KEY`.
2. Deploy with `supabase functions deploy monthly-report-insights`.
3. The Supabase project must have `SUPABASE_URL` and `SUPABASE_ANON_KEY` available to Edge Functions (Supabase provides these by default).

The AI briefing is descriptive and advisory. Sales of any medicine must not be interpreted as a measure of community health prevalence. Transfer suggestions are computed from the report's sales and unexpired batch stock; the user reviews source, batch, and quantity, and the app executes the existing `transfer_stock_between_shops` RPC.
