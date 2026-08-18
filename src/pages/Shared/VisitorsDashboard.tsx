import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../supabaseClient';
import { attachHostNames } from '../../lib/hostNames';
import { formatTime } from '../../lib/formatDate';
import { STATUS_STYLES } from '../../lib/statusStyles';
import { istDayStart } from '../../lib/visitExpiry';
import PreApproveForm from '../HOD/PreApproveForm';
import type { Visit } from '../../types/index';

type VisitRow = Visit & { host?: { id: string; full_name: string } };

export default function VisitorsDashboard(): React.ReactElement {
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPreReg, setShowPreReg] = useState(false);

  // IST midnight. This was the UTC date key passed as a bare `2026-08-17`,
  // which Postgres casts to 00:00 UTC — 05:30 IST — so the staff view of
  // today's visitors began five and a half hours into the day.
  const dayStart = useMemo(() => istDayStart().toISOString(), []);

  const fetchVisits = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('visits')
        // The host embed carried an unbalanced `))`, which PostgREST rejects
        // outright — so this select had never returned a row and the page
        // rendered its empty state permanently, with the parse error swallowed
        // by the `if (error) return` below.
        .select('*, visitor:visitor_id(*), department:department_id(name), host:host_id(id)')
        .gte('created_at', dayStart)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) return;
      const rows = (data ?? []) as unknown as VisitRow[];
      const withHosts = await attachHostNames(rows);
      setVisits(withHosts as unknown as VisitRow[]);
    } finally {
      setLoading(false);
    }
  }, [dayStart]);

  useEffect(() => { void fetchVisits(); }, [fetchVisits]);

  useEffect(() => {
    const channel = supabase.channel('dashboard-visits')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'visits' }, () => {
        void fetchVisits();
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [fetchVisits]);

  const stats = useMemo(() => {
    const checkedIn = visits.filter((v) => v.status === 'checked_in');
    const pending = visits.filter((v) => v.status === 'pending_approval');
    const approved = visits.filter((v) => v.status === 'approved' || v.status === 'walkin_approved');
    const departed = visits.filter((v) => v.status === 'checked_out');
    return {
      checkedIn: checkedIn.length,
      pending: pending.length,
      approved: approved.length,
      total: visits.length - departed.length,
      inside: checkedIn.length,
    };
  }, [visits]);

  return (
    <div className="space-y-6">
      {/* Page heading */}
      <div className="revamp-greeting flex items-start justify-between gap-4">
        <div>
          <p className="revamp-greeting-eyebrow">Gate Operations</p>
          <h1 className="text-xl font-bold text-navy-900 dark:text-white">Visitors</h1>
          <p className="text-sm text-navy-500 dark:text-navy-400 mt-0.5">Pre-register your visitors and track today's activity</p>
        </div>
        <button
          type="button"
          onClick={() => setShowPreReg((s) => !s)}
          className={showPreReg ? 'btn-secondary shrink-0' : 'btn-primary shrink-0'}
        >
          {showPreReg ? 'Close' : '+ Pre-Register a Visitor'}
        </button>
      </div>

      {showPreReg && (
        <PreApproveForm
          onPreApproved={() => { setShowPreReg(false); void fetchVisits(); }}
        />
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="stat-card">
          <p className="stat-label">New Today</p>
          <p className="stat-value text-brand-600 dark:text-brand-300">{loading ? '—' : stats.approved + stats.inside}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">On-site</p>
          <p className="stat-value text-success-600 dark:text-success-700">{loading ? '—' : stats.inside}</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Pending</p>
          <p className="stat-value text-amber-600 dark:text-amber-300">{loading ? '—' : stats.pending}</p>
        </div>
      </div>

      {/* Live queue */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-navy-800 uppercase tracking-wide">Live Activity</h2>
          <span className="flex items-center gap-1.5 text-[11px] text-navy-500 dark:text-navy-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-success-500" />
            </span>
            Live
          </span>
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-16 rounded-xl bg-surface-100 animate-pulse" />
            ))}
          </div>
        ) : visits.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-sm text-navy-500 dark:text-navy-400">No activity today</p>
          </div>
        ) : (
          <div className="space-y-2">
            {visits.slice(0, 20).map((v) => {
              const s = STATUS_STYLES[v.status]!
              return (
                <div key={v.id} className="card card-hover p-3.5 flex items-center gap-4">
                  {/* Status dot */}
                  <span className={`shrink-0 h-2.5 w-2.5 rounded-full ${s.dot}`} />

                  {/* Visitor info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-navy-900 dark:text-white truncate">
                      {v.visitor?.full_name ?? 'Unknown'}
                    </p>
                    <p className="text-xs text-navy-500 dark:text-navy-400 truncate">
                      {v.purpose} · {v.department?.name ?? '—'}
                    </p>
                  </div>

                  {/* Host & time */}
                  <div className="hidden sm:block text-right shrink-0">
                    <p className="text-xs font-medium text-navy-600">{v.host?.full_name ?? '—'}</p>
                    <p className="text-[11px] text-navy-500 dark:text-navy-400">{formatTime(v.created_at)}</p>
                  </div>

                  {/* Status badge */}
                  <span className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold ${s.bg} ${s.text}`}>
                    {s.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
