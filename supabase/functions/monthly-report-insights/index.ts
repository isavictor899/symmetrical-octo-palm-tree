import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const ALLOWED_ORIGINS = ['https://pos.enoralabs.co.ke', 'http://localhost:5173'];

// Built per request: a shared module-level variable could send one request's
// headers with another request's response when two arrive at once.
function buildCors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
}

function cleanAnalytics(analytics: Record<string, unknown>) {
  const safeText = (value: unknown, maxLength = 100) => String(value ?? '').slice(0, maxLength);
  const safeNumber = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(number, 1_000_000_000)) : 0;
  };
  const cleanRows = (value: unknown, maxRows: number) => Array.isArray(value)
    ? value.slice(0, maxRows).map((row) => {
      const item = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
      return {
        name: safeText(item.name),
        quantity: safeNumber(item.quantity),
        amount: safeNumber(item.amount),
        salesTotal: safeNumber(item.salesTotal),
        transactions: safeNumber(item.transactions),
        unitsSold: safeNumber(item.unitsSold),
      };
    })
    : [];

  const opportunities = Array.isArray(analytics.stockTransferOpportunities)
    ? analytics.stockTransferOpportunities.slice(0, 5).map((raw) => {
      const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return {
        drugName: safeText(row.drugName),
        targetShopName: safeText(row.targetShopName),
        targetSold: safeNumber(row.targetSold),
        targetStock: safeNumber(row.targetStock),
        possibleSources: Array.isArray(row.possibleSources) ? row.possibleSources.slice(0, 5).map((source) => {
          const shop = (source && typeof source === 'object' ? source : {}) as Record<string, unknown>;
          return { shopName: safeText(shop.shopName), available: safeNumber(shop.available) };
        }) : [],
      };
    })
    : [];

  return {
    totalSales: safeNumber(analytics.totalSales),
    returnsAmount: safeNumber(analytics.returnsAmount),
    transactions: safeNumber(analytics.transactions),
    unitsSold: safeNumber(analytics.unitsSold),
    topSelling: cleanRows(analytics.topSelling, 8),
    leastSelling: cleanRows(analytics.leastSelling, 8),
    shops: cleanRows(analytics.shops, 30),
    stockTransferOpportunities: opportunities,
  };
}

Deno.serve(async (request) => {
  const corsHeaders = buildCors(request.headers.get('origin'));
  const jsonResponse = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return jsonResponse({ error: 'Sign in to generate report insights.' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
  if (!supabaseUrl || !supabaseAnonKey) return jsonResponse({ error: 'Supabase function environment is incomplete.' }, 500);

  try {
    const payload = await request.json();
    const { month, shopIds, analytics: rawAnalytics } = payload ?? {};
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return jsonResponse({ error: 'Choose a valid report month.' }, 400);
    }
    if (!Array.isArray(shopIds) || shopIds.length < 1 || shopIds.length > 30 || !rawAnalytics || typeof rawAnalytics !== 'object') {
      return jsonResponse({ error: 'The report data is incomplete.' }, 400);
    }
    if (shopIds.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) {
      return jsonResponse({ error: 'The report data is incomplete.' }, 400);
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return jsonResponse({ error: 'Your session is invalid. Sign in again.' }, 401);

    // 1. A saved briefing that is still fresh? get_monthly_insight also checks
    //    the caller is an active admin and every shop is in their organization.
    const { data: saved, error: savedError } = await supabase.rpc('get_monthly_insight', {
      p_month: month,
      p_shop_ids: shopIds,
    });
    if (savedError) {
      const status = savedError.code === 'P0001' ? 403 : 500;
      return jsonResponse({ error: status === 403 ? savedError.message : 'Unable to load saved insights.' }, status);
    }
    if (Array.isArray(saved) && saved.length > 0) {
      return jsonResponse({ insights: saved[0].insights, generatedAt: saved[0].generated_at, cached: true });
    }

    // 2. Generating a new one spends the admin's daily AI quota.
    if (!geminiApiKey) return jsonResponse({ error: 'AI reporting is not configured. Add the Gemini API key as the GEMINI_API_KEY function secret.' }, 503);
    const { data: allowed, error: quotaError } = await supabase.rpc('consume_insight_quota', { p_limit: 10 });
    if (quotaError) return jsonResponse({ error: 'Unable to check the daily AI limit. Try again.' }, 500);
    if (!allowed) return jsonResponse({ error: 'Daily AI insight limit reached. Try again tomorrow.' }, 429);

    const analytics = cleanAnalytics(rawAnalytics as Record<string, unknown>);
    const promptData = JSON.stringify({ month, analytics });
    if (promptData.length > 16_000) return jsonResponse({ error: 'The report data exceeds the AI summary limit.' }, 413);

    const geminiResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You write concise monthly pharmacy operations briefings for a shop administrator. Use only facts and numbers in the supplied aggregated report JSON; do not invent causes or figures. Highlight the clearest sales changes, best and slowest sellers, and operational stock-balancing opportunities if present. Never infer community health rates, pregnancy rates, a diagnosis, customer intent, or other health outcomes from medicine sales. Do not provide clinical advice. Describe medicine sales as sales patterns only, and stock transfers as optional operations decisions for a human to review. Return 3 to 5 short plain-text bullet points. State when the available data is not enough to support a conclusion.' }] },
        contents: [{ role: 'user', parts: [{ text: `Summarize these aggregated monthly report figures for ${month}: ${promptData}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 320 },
      }),
    });

    const geminiPayload = await geminiResponse.json().catch(() => ({}));
    if (!geminiResponse.ok) {
      const providerStatus = String(geminiPayload?.error?.status || 'API_ERROR').slice(0, 80);
      const providerMessage = String(geminiPayload?.error?.message || 'No provider details were returned.').slice(0, 240);
      console.error('Gemini report request failed:', geminiResponse.status, providerStatus, providerMessage);
      return jsonResponse({ error: `Gemini API error (${geminiResponse.status} ${providerStatus}): ${providerMessage}` }, 502);
    }
    const insights = geminiPayload?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || '').join('').trim();
    if (!insights) return jsonResponse({ error: 'The AI service returned an empty briefing. Please try again.' }, 502);

    // 3. Save it so the next visit shows it without another AI call. A failed
    //    save must not hide a briefing the admin has already paid quota for.
    const { data: generatedAt, error: saveError } = await supabase.rpc('save_monthly_insight', {
      p_month: month,
      p_shop_ids: shopIds,
      p_insights: insights,
    });
    if (saveError) console.error('Saving monthly insight failed:', saveError.code, saveError.message);

    return jsonResponse({ insights, generatedAt: generatedAt ?? new Date().toISOString(), cached: false });
  } catch (error) {
    console.error('Monthly report insights failed:', error instanceof Error ? error.message : 'Unknown error');
    return jsonResponse({ error: 'Unable to generate monthly report insights.' }, 500);
  }
});