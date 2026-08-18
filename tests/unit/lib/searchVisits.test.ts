import { describe, it, expect, vi, beforeEach } from 'vitest';

// Chainable builder mock, keyed by table, following the pattern in
// tests/unit/lib/activeVisit.test.ts. `visits` supports .ilike (ref search)
// and .in (visitor-id search); `visitors` supports .ilike (name/phone
// search). Each terminal call resolves through its own vi.fn so a test can
// script per-column responses.
const mockVisitsIlike = vi.hoisted(() => vi.fn());
const mockVisitsIn = vi.hoisted(() => vi.fn());
const mockVisitsEq = vi.hoisted(() => vi.fn());
const mockVisitorsIlike = vi.hoisted(() => vi.fn());
const calls = vi.hoisted(() => ({
  visitsIlike: [] as [string, string][],
  visitsIn: [] as [string, string[]][],
  visitsEq: [] as [string, string][],
  visitorsIlike: [] as [string, string][],
}));

vi.mock('../../../src/supabaseClient', () => {
  const visitsBuilder: any = {};
  visitsBuilder.select = () => visitsBuilder;
  visitsBuilder.ilike = (col: string, pattern: string) => {
    calls.visitsIlike.push([col, pattern]);
    return mockVisitsIlike(col, pattern);
  };
  visitsBuilder.in = (col: string, ids: string[]) => {
    calls.visitsIn.push([col, ids]);
    return mockVisitsIn(col, ids);
  };
  // .eq is the OTP leg (visits.otp_code = <code>) — a 4–8 digit query also
  // triggers an exact OTP lookup (migration 094).
  visitsBuilder.eq = (col: string, val: string) => {
    calls.visitsEq.push([col, val]);
    return mockVisitsEq(col, val);
  };

  const visitorsBuilder: any = {};
  visitorsBuilder.select = () => visitorsBuilder;
  visitorsBuilder.ilike = (col: string, pattern: string) => {
    calls.visitorsIlike.push([col, pattern]);
    return mockVisitorsIlike(col, pattern);
  };

  return {
    supabase: {
      from: (table: string) => (table === 'visits' ? visitsBuilder : visitorsBuilder),
      // attachHostNames short-circuits when no row carries a host_id, which
      // every fixture below deliberately omits — so rpc is never reached,
      // but stub it so an accidental call fails loudly instead of hanging.
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    },
  };
});

import { searchAllVisits, VISIT_SEARCH_LIMIT } from '../../../src/lib/searchVisits';

function makeVisit(overrides: Record<string, unknown>) {
  return {
    id: 'visit-default',
    ref_number: 'VIS-20260801-0001',
    visitor_id: 'visitor-1',
    department_id: 'dept-1',
    status: 'approved',
    created_at: '2026-08-01T00:00:00Z',
    visitor: { full_name: 'Someone', phone: '9876543210' },
    ...overrides,
  };
}

beforeEach(() => {
  calls.visitsIlike = [];
  calls.visitsIn = [];
  calls.visitorsIlike = [];
  calls.visitsEq = [];
  mockVisitsIlike.mockReset().mockResolvedValue({ data: [], error: null });
  mockVisitsIn.mockReset().mockResolvedValue({ data: [], error: null });
  mockVisitsEq.mockReset().mockResolvedValue({ data: [], error: null });
  mockVisitorsIlike.mockReset().mockResolvedValue({ data: [], error: null });
});

describe('searchAllVisits — short query', () => {
  it('returns [] for a query under 2 characters and issues no query at all', async () => {
    const result = await searchAllVisits('a');
    expect(result).toEqual([]);
    expect(mockVisitsIlike).not.toHaveBeenCalled();
    expect(mockVisitorsIlike).not.toHaveBeenCalled();
    expect(mockVisitsIn).not.toHaveBeenCalled();
  });

  it('treats an empty/whitespace query the same way', async () => {
    expect(await searchAllVisits('   ')).toEqual([]);
  });
});

describe('searchAllVisits — matching', () => {
  it('finds a visit by a ref-number substring', async () => {
    const visit = makeVisit({ id: 'v-ref', ref_number: 'VIS-20260804-0023' });
    mockVisitsIlike.mockResolvedValue({ data: [visit], error: null });

    const result = await searchAllVisits('20260804');
    expect(result.map((v) => v.id)).toContain('v-ref');
  });

  it('finds a visit by a visitor name substring', async () => {
    mockVisitorsIlike.mockImplementation((col: string) =>
      col === 'full_name'
        ? Promise.resolve({ data: [{ id: 'visitor-9' }], error: null })
        : Promise.resolve({ data: [], error: null }),
    );
    const visit = makeVisit({ id: 'v-name', visitor_id: 'visitor-9' });
    mockVisitsIn.mockResolvedValue({ data: [visit], error: null });

    const result = await searchAllVisits('Priya');
    expect(result.map((v) => v.id)).toContain('v-name');
    expect(calls.visitsIn[0][1]).toEqual(['visitor-9']);
  });

  it('finds a visit by its exact OTP (a 4–8 digit query)', async () => {
    const visit = makeVisit({ id: 'v-otp', otp_code: '405066' });
    mockVisitsEq.mockImplementation((col: string) =>
      col === 'otp_code'
        ? Promise.resolve({ data: [visit], error: null })
        : Promise.resolve({ data: [], error: null }),
    );
    const result = await searchAllVisits('405066');
    expect(result.map((v) => v.id)).toContain('v-otp');
    expect(calls.visitsEq.some(([col, val]) => col === 'otp_code' && val === '405066')).toBe(true);
  });

  it('does not run an OTP lookup for a non-numeric query', async () => {
    await searchAllVisits('Priya');
    expect(calls.visitsEq.length).toBe(0);
  });

  it('finds a visit by a phone-number substring (query with 2+ digits)', async () => {
    mockVisitorsIlike.mockImplementation((col: string) =>
      col === 'phone'
        ? Promise.resolve({ data: [{ id: 'visitor-7' }], error: null })
        : Promise.resolve({ data: [], error: null }),
    );
    const visit = makeVisit({ id: 'v-phone', visitor_id: 'visitor-7' });
    mockVisitsIn.mockResolvedValue({ data: [visit], error: null });

    const result = await searchAllVisits('98765');
    expect(result.map((v) => v.id)).toContain('v-phone');
  });

  it('does not run a phone lookup when the query has fewer than 2 digits', async () => {
    await searchAllVisits('a1bc');
    expect(calls.visitorsIlike.some(([col]) => col === 'phone')).toBe(false);
  });

  it('dedupes a visit matched by BOTH ref and name — appears exactly once', async () => {
    const visit = makeVisit({ id: 'v-both', ref_number: 'VIS-20260805-0099', visitor_id: 'visitor-5' });
    mockVisitsIlike.mockResolvedValue({ data: [visit], error: null });
    mockVisitorsIlike.mockImplementation((col: string) =>
      col === 'full_name'
        ? Promise.resolve({ data: [{ id: 'visitor-5' }], error: null })
        : Promise.resolve({ data: [], error: null }),
    );
    mockVisitsIn.mockResolvedValue({ data: [visit], error: null });

    const result = await searchAllVisits('Nair');
    expect(result.filter((v) => v.id === 'v-both')).toHaveLength(1);
  });

  it('returns results ordered most-recent-first', async () => {
    const older = makeVisit({ id: 'v-old', created_at: '2026-08-01T00:00:00Z' });
    const newer = makeVisit({ id: 'v-new', created_at: '2026-08-10T00:00:00Z' });
    mockVisitsIlike.mockResolvedValue({ data: [older, newer], error: null });

    const result = await searchAllVisits('VIS');
    expect(result.map((v) => v.id)).toEqual(['v-new', 'v-old']);
  });

  it.each(['checked_out', 'rejected'])(
    'returns a CLOSED visit with status %s — the whole point of the change',
    async (status) => {
      const visit = makeVisit({ id: `v-${status}`, status });
      mockVisitsIlike.mockResolvedValue({ data: [visit], error: null });

      const result = await searchAllVisits('VIS');
      expect(result.some((v) => v.id === `v-${status}` && v.status === status)).toBe(true);
    },
  );

  it('honours a custom limit', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeVisit({ id: `v-${i}`, created_at: `2026-08-0${i + 1}T00:00:00Z` }),
    );
    mockVisitsIlike.mockResolvedValue({ data: rows, error: null });

    const result = await searchAllVisits('VIS', 2);
    expect(result).toHaveLength(2);
  });

  it('defaults to VISIT_SEARCH_LIMIT when no limit is given', async () => {
    const rows = Array.from({ length: VISIT_SEARCH_LIMIT + 10 }, (_, i) =>
      makeVisit({ id: `v-${i}`, created_at: `2026-08-01T00:00:${String(i).padStart(2, '0')}Z` }),
    );
    mockVisitsIlike.mockResolvedValue({ data: rows, error: null });

    const result = await searchAllVisits('VIS');
    expect(result).toHaveLength(VISIT_SEARCH_LIMIT);
  });
});

describe('searchAllVisits — resilience', () => {
  it('returns [] rather than throwing when the ref lookup errors', async () => {
    mockVisitsIlike.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await searchAllVisits('VIS');
    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('still returns matches from other legs when one leg errors', async () => {
    mockVisitsIlike.mockResolvedValue({ data: null, error: { message: 'boom' } });
    mockVisitorsIlike.mockImplementation((col: string) =>
      col === 'full_name'
        ? Promise.resolve({ data: [{ id: 'visitor-3' }], error: null })
        : Promise.resolve({ data: [], error: null }),
    );
    const visit = makeVisit({ id: 'v-survives', visitor_id: 'visitor-3' });
    mockVisitsIn.mockResolvedValue({ data: [visit], error: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await searchAllVisits('Nair');
    expect(result.map((v) => v.id)).toContain('v-survives');
  });
});

describe('searchAllVisits — ILIKE wildcard escaping', () => {
  it('escapes a literal % so it does not become a match-everything wildcard', async () => {
    await searchAllVisits('50%off');
    const [, pattern] = calls.visitsIlike[0];
    expect(pattern).toBe('%50\\%off%');
  });

  it('escapes a literal _ the same way', async () => {
    await searchAllVisits('a_b');
    const [, pattern] = calls.visitsIlike[0];
    expect(pattern).toBe('%a\\_b%');
  });
});
