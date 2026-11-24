# Security review report

**Repository:** `isavictor899/symmetrical-octo-palm-tree`  
**Reviewed revision:** `2bc3138ca2888bce8e02e50cf767d54216b1bdea` (local `main` matches GitHub `HEAD`)  
**Review date:** 2026-11-20  
**Scope:** React/Vite client, Supabase Edge Function, tracked SQL migrations, repository configuration, and production npm dependencies.

## Executive summary

I found one medium-risk service availability concern: the Gemini reporting proxy has no application-level rate limit. I also found that the committed RLS audit script contains invalid SQL, which prevents it from checking anonymous table privileges. The production dependency audit reported zero known vulnerabilities.

I did not confirm a client-side XSS or committed secret in the reviewed application source. This repository does not contain the original schema and policies for core tables such as `staff`, `shops`, `sales`, and `batches`, so tenant isolation and their RPC authorization cannot be fully verified from Git. The live Supabase project still needs an RLS and grants review.

## Findings

### SBP-001 — Gemini reporting endpoint has no application-level rate limit

- **Severity:** Medium
- **Location:** `supabase/functions/monthly-report-insights/index.ts:64-68, 115-127`; `supabase/config.toml:1-2`
- **Evidence:** The function verifies a bearer token and requires an administrator, but accepts each authorized request and forwards it to Gemini. The input-size limit is per request; there is no per-user, organization, or time-window request quota in the function.
- **Impact:** A compromised administrator session, or an administrator repeatedly invoking the endpoint, could consume the Gemini project’s available quota and temporarily prevent other authorized users from getting insights. This is primarily a service availability and provider-quota risk, not an unauthenticated access path.
- **Recommended fix:** Add server-side rate limits keyed by authenticated user and/or organization, plus a daily request budget. Keep Supabase JWT verification and the existing organization/shop authorization checks. Confirm whether Supabase or the Gemini project already imposes a suitable quota; none is configured in this repository.
- **False-positive note:** External gateway or provider limits may reduce exposure, but they are not visible in this codebase.

### SBP-002 — RLS audit query for anonymous grants is syntactically invalid

- **Severity:** Low (security-audit reliability)
- **Location:** `docs/security/verify-rls.sql:59-63`
- **Evidence:** The query uses `table_sc` instead of the `table_schema` column and line 62 ends with `grantee = 'anon'hema`, which is invalid SQL.
- **Impact:** Section 4 cannot run as written, so the documented audit cannot confirm whether the `anon` role has table privileges. This does not itself change database permissions, but it can leave a meaningful exposure unchecked.
- **Recommended fix:** Change the filter to `where table_schema = 'public' and grantee = 'anon'`, then run the full audit against the live Supabase database and review every result.
- **False-positive notes:** None; the query text is invalid as committed.

## Verification gaps (not confirmed vulnerabilities)

- The tracked migrations modify existing pharmacy tables but do not define the original schema or baseline RLS policies for core tables. The repository also does not include the definitions of every RPC used by the app. I therefore cannot certify shop-level data isolation or all RPC permission checks from this checkout alone.
- The repository does not define HTTP security headers for its production host. Check the deployed response headers and hosting configuration for a compatible Content Security Policy and clickjacking protection; those may be configured outside Git.
- Browser Supabase URL and anon key configuration are expected to be public client settings. Keep service-role keys, Gemini keys, and other private credentials out of `VITE_*` variables and browser assets.

## Positive controls observed

- The monthly insights function requires JWT verification in `supabase/config.toml` and also checks the bearer token, administrator role, and organization ownership of submitted shop IDs.
- That function bounds and shapes the submitted analytics data and instructs the model not to infer health prevalence or provide clinical advice.
- The checked-in anon privilege migration revokes anonymous execution on public RPCs and table privileges from `anon` for tables present when it runs. Its effectiveness in production still depends on the migration having been applied and the live grants being checked.
- The receipt-print HTML paths escape text fields before inserting them into a new document.
- `npm audit --omit=dev` reported **0 vulnerabilities** in production dependencies at the time of review.

## Recommended next steps

1. Fix and run `docs/security/verify-rls.sql` against the production Supabase project; include the policy and anonymous-RPC result grids in a follow-up review.
2. Add per-user/organization quotas to `monthly-report-insights`.
3. Review deployed response headers and confirm the GitHub revision deployed to production.
