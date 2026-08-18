// Universal visit search for the guard check-in desk.
//
// CheckInPanel.loadData only ever fetched `status in ('approved',
// 'walkin_approved')` — the open, actionable statuses. That is the right
// scope for the arrivals board, but it quietly became the ONLY way to look a
// visit up: once a pass was used (checked_out), lapsed (no_show / expired) or
// declined (rejected / cancelled), it vanished from search entirely. A guard
// re-typing a ref number off yesterday's printed pass, or a host asking "did
// so-and-so ever show up?", got "No match found" for a visit that plainly
// existed.
//
// SEARCHING answers "does this exist?" — every status, no filtering.
// ACTING (checking someone in) answers "can I do something about it right
// now?" and stays governed by CheckInPanel / checkInMatches.ts, which is
// deliberately scoped to what is due today. This module only ever answers
// the first question; callers decide what a closed result is allowed to do.
import { supabase } from '../supabaseClient';
import type { Visit } from '../types/index';
import { attachHostNames } from './hostNames';

export const VISIT_SEARCH_LIMIT = 50;

const VISIT_SELECT = '*, visitor:visitors(*), department:departments(id, name, code, created_at)';

/**
 * ILIKE treats `%` and `_` as wildcards, so a guard typing a literal percent
 * sign (or an underscore, common in vendor names) would otherwise turn their
 * own search into a match-everything pattern. Escape both before wrapping in
 * `%...%`.
 */
function escapeIlike(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

async function fetchVisitsByRef(pattern: string): Promise<Visit[]> {
  const { data, error } = await supabase.from('visits').select(VISIT_SELECT).ilike('ref_number', pattern);
  if (error) {
    console.error('[searchVisits] ref_number lookup failed', error);
    return [];
  }
  return (data as unknown as Visit[]) ?? [];
}

// The OTP a visitor is given at pre-registration (or a walk-in's guard-facing
// OTP) is the primary way a guard finds a visit at the gate. Matched exactly:
// a 6-digit code is unique among open visits (migration 094), so an exact hit
// is unambiguous, where a substring would collide with phone fragments.
async function fetchVisitsByOtp(code: string): Promise<Visit[]> {
  const { data, error } = await supabase.from('visits').select(VISIT_SELECT).eq('otp_code', code);
  if (error) {
    console.error('[searchVisits] otp_code lookup failed', error);
    return [];
  }
  return (data as unknown as Visit[]) ?? [];
}

async function fetchVisitorIds(column: 'full_name' | 'phone', pattern: string): Promise<string[]> {
  const { data, error } = await supabase.from('visitors').select('id').ilike(column, pattern);
  if (error) {
    console.error(`[searchVisits] visitors.${column} lookup failed`, error);
    return [];
  }
  return ((data as { id: string }[] | null) ?? []).map((r) => r.id);
}

async function fetchVisitsByVisitorIds(ids: string[]): Promise<Visit[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from('visits').select(VISIT_SELECT).in('visitor_id', ids);
  if (error) {
    console.error('[searchVisits] visits-by-visitor lookup failed', error);
    return [];
  }
  return (data as unknown as Visit[]) ?? [];
}

/**
 * Finds every visit — any status — matching `query` against ref number,
 * visitor name or visitor phone. Never throws: a Supabase failure on any one
 * leg is logged and treated as an empty result for that leg, so the other
 * legs can still answer.
 */
export async function searchAllVisits(query: string, limit?: number): Promise<Visit[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const effectiveLimit = limit ?? VISIT_SEARCH_LIMIT;
  const pattern = `%${escapeIlike(trimmed)}%`;
  const digits = digitsOnly(trimmed);

  // A 4–8 digit query is treated as a possible gate OTP (exact match).
  const isOtpLike = /^\d{4,8}$/.test(trimmed);

  try {
    const [refVisits, otpVisits, nameIds, phoneIds] = await Promise.all([
      fetchVisitsByRef(pattern),
      isOtpLike ? fetchVisitsByOtp(trimmed) : Promise.resolve<Visit[]>([]),
      fetchVisitorIds('full_name', pattern),
      digits.length >= 2 ? fetchVisitorIds('phone', `%${digits}%`) : Promise.resolve<string[]>([]),
    ]);

    // One combined lookup for both name- and phone-matched visitors, rather
    // than two separate visits queries, to keep round-trips down.
    const visitorIds = [...new Set([...nameIds, ...phoneIds])];
    const visitorVisits = await fetchVisitsByVisitorIds(visitorIds);

    const merged = new Map<string, Visit>();
    for (const v of [...refVisits, ...otpVisits, ...visitorVisits]) merged.set(v.id, v);

    const rows = [...merged.values()]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, effectiveLimit);

    return await attachHostNames(rows);
  } catch (err) {
    console.error('[searchVisits] unexpected failure', err);
    return [];
  }
}
