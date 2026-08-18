import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useGateActivity } from '../../lib/useGateActivity';
import { istDateKey } from '../../lib/visitExpiry';
import { formatDateTime } from '../../lib/formatDate';
import type { ReportVisit } from '../../lib/reportRow';
import { safeErrorMessage } from '../../lib/errors';
import QRCode from 'qrcode';
import { buildQrPayload } from '../../lib/qrToken';
import SuccessToast from '../../components/SuccessToast';
import CheckInFrame from './CheckInFrame';
import LiveQueueTable from './LiveQueueTable';
import CardReturnConfirm from './CardReturnConfirm';
import { logVisitExit } from '../../lib/checkOutFlow';
import { printVisitorBadge } from '../../lib/printBadge';
import EntryExitTabs, { type EntryExitLane } from './EntryExitTabs';

// Entry & Exit — the guard's second tab (/guard/inside-now).
//
// Named "Live Queue" until 2026-08-14, then "Inside Now" until 2026-08-15. It
// lists everyone who has been through the gate: those still inside, and those
// who have checked out since the IST day began. Neither older name survived the
// widening — "Live Queue" described the dashboard's Expected Today panel (people
// still waiting, who are not on this page at all), and "Inside Now" was a claim
// the list stopped making the moment it carried departures. "Entry & Exit" is
// the two events the tab actually records and nothing more.
//
// The FILE keeps its old name, as it did through the last rename: renaming a
// component half the guard surface imports buys nothing the route and the label
// do not already say. Both /guard/inside-now and /guard/live-queue stay
// routable — they are in guards' bookmarks and in every ?verify= link the
// dashboard has emitted.
//
// TWO LANES, not one merged list (client instruction, 2026-08-15):
// EntryExitTabs toggles between Checked In and Checked Out. A guard opens this
// tab already knowing which of the two they are asking about, and interleaving
// them meant scanning past the group you did not want. Each lane carries its
// own count on the tab and its own empty state, so "nobody is inside" and
// "nobody has left yet" stop being the same sentence.
//
// Selecting a row opens that visitor's frame below the table — the identity
// photo, the step tracker, the visit timeline and the white pass. The guard
// flips between visitors by clicking rows.
//
// This page STARTS no check-in. Un-checked-in arrivals are not here at all;
// they stay on the dashboard's Expected Today panel, which is the one route into
// a check-in. The "N arrivals still at the gate" banner and the photo + OCR
// overlay it opened were removed 2026-08-14 (client instruction).
//
// It does END one. /visitors/inside was the only place a visitor could be
// checked out, so retiring that surface would have meant nobody could ever
// leave. The exit lands here because this is the list of people who are
// actually inside — and it goes through the same CardReturnConfirm dialog and
// the same lib/checkOutFlow write the old surface used, so "did a human
// witness this exit" and "did the card come back" keep one answer each.

// The two times the tab is named for. A row always has an entry time (the
// query requires `checked_in_at`); the exit is an em dash until it happens,
// never a blank — blank reads as "not recorded", and on this list it means
// "still here", which is the difference the guard is looking for.
//
// ALWAYS THE DATE AS WELL AS THE TIME (client instruction, 2026-08-17). These
// were `formatStamp`, which prints a bare time when the instant falls on
// today's IST day and pays for the date only on older rows. The saving is not
// worth what it costs the reader: the two formats are indistinguishable at a
// glance, so a guard scanning the In column cannot tell whether "09:15" is a
// today row rendered short or an older row whose date they have skipped past —
// and this list carries visitors from earlier days BY DESIGN (anyone still
// inside is here regardless of when they arrived, and an exit that crossed
// midnight is the row most often asked about). `formatDateTime` states the day
// on every row, so no row has to be read against the format of its neighbours.
// This is the same rule CLAUDE.md already applies to every expected time.
function timeOf(v: ReportVisit): string {
  return formatDateTime(v.checked_in_at ?? v.scheduled_for ?? v.created_at);
}

function exitTimeOf(v: ReportVisit): string {
  return v.checked_out_at ? formatDateTime(v.checked_out_at) : '—';
}

const initialsOf = (name: string | null | undefined) =>
  ((name ?? 'U').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'U');

export default function GuardLiveQueue(): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const [clock, setClock] = useState(() => new Date());
  const today = istDateKey(clock);
  const { visits, loading: visitsLoading } = useGateActivity(today);

  // The visitor whose details render in the right-hand frame. Selecting a
  // queue row updates it live; arriving at /guard/inside-now?verify=<id>
  // (from the dashboard's ID Verification card) preselects that visitor.
  const [activeVisit, setActiveVisit] = useState<ReportVisit | null>(null);

  // Which lane is on screen. Defaults to the people still on site: they are the
  // only rows a guard can still act on, and the far commoner reason to open
  // this tab at all.
  const [lane, setLane] = useState<EntryExitLane>('inside');

  // The visitor the guard has asked to check out. Holding the visit here (not
  // a boolean) means the confirm dialog always names the row that was clicked,
  // even if the live subscription reorders the table underneath it.
  const [exitTarget, setExitTarget] = useState<ReportVisit | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState('');
  // Return-a-badge: the guard types the number printed on the card the visitor
  // hands back, and the matching on-site visit is checked out. The badge is
  // then free to reissue (a new check-in can type the same number). Runs off
  // the already-loaded `inside` list — no extra query.
  const [badgeInput, setBadgeInput] = useState('');

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const id = searchParams.get('verify');
    if (id && !activeVisit) {
      const found = visits.find((v) => v.id === id) ?? null;
      if (found) setActiveVisit(found);
    }
  }, [searchParams, visits, activeVisit]);

  // Refresh the selected row against the freshest subscription data so the
  // right panel can never show a stale status (e.g. right after check-in).
  const liveActive = activeVisit ? (visits.find((v) => v.id === activeVisit.id) ?? activeVisit) : null;
  useEffect(() => {
    if (!liveActive) return;
    // THE SAME QR THE VISITOR IS HOLDING — byte for byte (client instruction,
    // 2026-08-16). The payload, the pixel width and the ink colour all match
    // `PreApprovalPass`, so the code on the guard's screen and the code on the
    // HOD-issued pass are the same image, not merely two codes that happen to
    // resolve to the same visit.
    //
    // There is NO `vms://visit/<ref>` fallback any more, and its removal is the
    // point rather than a tidy-up. A visit with no `qr_token` used to get a
    // second, invented payload that nothing in the app can parse — `parseQrPayload`
    // rejects any `vms://` URL that is not `vms://checkin/`, so scanning it at
    // the gate failed. That produced the exact complaint this change answers: a
    // QR on the guard's screen that did not match the visitor's pass and could
    // not be scanned. A visit with no token now renders no QR at all, which the
    // rail already draws an honest placeholder for.
    if (!liveActive.qr_token) { setQrDataUrl(null); return; }
    QRCode.toDataURL(buildQrPayload(liveActive.qr_token), {
      width: 240,
      color: { dark: '#1e293b', light: '#ffffff' },
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [liveActive]);

  // Entry & Exit = everyone through the gate: still inside, plus today's
  // departures. Un-checked-in arrivals are not here at all — they live on the
  // dashboard's Expected Today panel, which is where a check-in starts.
  //
  // STILL INSIDE FIRST, each group by its own clock: the people on site are the
  // ones a guard can still act on, and putting a departure above them would
  // bury the only actionable rows on the page. Inside sorts by arrival (oldest
  // first — longest on site, closest to an overstay); departures sort by exit,
  // most recent first, because "who just left?" is the question asked of them.
  const inside = visits
    .filter((v) => v.status === 'checked_in')
    .sort((a, b) => (a.checked_in_at ?? a.created_at).localeCompare(b.checked_in_at ?? b.created_at));
  const departed = visits
    .filter((v) => v.status === 'checked_out')
    .sort((a, b) => (b.checked_out_at ?? b.created_at).localeCompare(a.checked_out_at ?? a.created_at));
  // Each lane is its own list. They used to be concatenated into one table,
  // which meant scanning past the group you were not asking about.
  const queue = lane === 'inside' ? inside : departed;
  const laneCounts = { inside: inside.length, departed: departed.length };

  const selectVisit = (v: ReportVisit) => {
    setActiveVisit(v);
  };

  const checkOutByBadge = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const q = badgeInput.trim();
    if (!q) return;
    const match = inside.find(
      (v) => (v.visitor_card_number ?? '').trim().toLowerCase() === q.toLowerCase(),
    );
    if (!match) {
      setError(`No visitor on site is holding badge "${q}". Check the number and try again.`);
      return;
    }
    setBadgeInput('');
    setExitTarget(match); // same CardReturnConfirm + logVisitExit write as a row click
  };

  const printBadge = () => { if (liveActive) printVisitorBadge(); };

  // The exit WRITE, reached only through CardReturnConfirm — the dialog names
  // the card the guard has to collect and stays disabled until it is ticked
  // back, so a completed check-out is the record of a witnessed handover.
  const confirmExit = async (visit: ReportVisit) => {
    setError('');
    const res = await logVisitExit(visit);
    if (!res.ok) { setError(res.message); return; }
    setExitTarget(null);
    // The right-hand frame described someone who is no longer inside; the
    // realtime subscription is about to drop them from the table too.
    setActiveVisit(null);
    setSearchParams({});
    setToast(`"${visit.visitor?.full_name ?? 'Visitor'}" checked out.`);
    setTimeout(() => setToast(null), 5000);
  };

  const closeSplitSelection = () => {
    setActiveVisit(null);
    setSearchParams({});
    setError('');
    setQrDataUrl(null);
  };

  return (
    <div className="space-y-5 animate-fade-in pb-4">
      <SuccessToast message={toast} onDismiss={() => setToast(null)} />

      {error && (
        <p className="rounded-xl border border-danger-500/30 bg-danger-600/10 px-4 py-3 text-sm text-danger-400">{error}</p>
      )}

      {/* Left column — arrival queue (always visible) */}
      <div className="rounded-2xl bg-surface-100/60 dark:bg-white/[0.03] border border-surface-200/60 dark:border-white/[0.07] p-5 shadow-glow-sm">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <span className="text-success-500">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </span>
            <h2 className="font-display text-h2 text-navy-950 dark:text-white">Entry &amp; Exit</h2>
          </div>
          {/* The count lives on the tabs now — a lane's number is the length of
              the list that lane opens, so a separate summary line would be a
              second place for the same fact to be stated. */}
        </div>

        {/* Return a badge — check a visitor out by the badge number they hand
            back at the gate. The number is then free to issue again. */}
        <form onSubmit={checkOutByBadge} className="mb-4 flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[200px]">
            <label htmlFor="return-badge" className="label">Return a badge — type the badge number to check out</label>
            <input
              id="return-badge"
              className="input"
              value={badgeInput}
              onChange={(e) => setBadgeInput(e.target.value)}
              placeholder="e.g. B-207"
              autoComplete="off"
            />
          </div>
          <button type="submit" className="btn-primary shrink-0" disabled={!badgeInput.trim()}>
            Check out by badge
          </button>
        </form>

        <div className="mb-4">
          <EntryExitTabs lane={lane} onSelect={setLane} counts={laneCounts} loading={visitsLoading} />
        </div>

        <LiveQueueTable
          queue={queue}
          loading={visitsLoading}
          initialsOf={initialsOf}
          timeOf={timeOf}
          exitTimeOf={exitTimeOf}
          onSelect={selectVisit}
          selectedId={liveActive?.id ?? null}
          emptyMessage={lane === 'inside'
            ? 'Nobody is on site right now.'
            : 'Nobody has checked out today.'}
          onCheckOut={setExitTarget}
        />
      </div>

      {/* Right column — check-in frame of the selected visitor. Rendered for
          every visitor, awaiting or already checked in, so the guard sees
          details · photo + timeline · pass for anyone in the queue. */}
      {liveActive && (
        <CheckInFrame
          activeVisit={liveActive}
          qrDataUrl={qrDataUrl}
          onPrintBadge={printBadge}
          onClose={closeSplitSelection}
          // Only somebody actually inside can leave. Every row in this table is
          // checked_in, but the frame is reused elsewhere, so the guard is
          // explicit rather than assumed.
          onCheckOut={liveActive.status === 'checked_in' ? () => setExitTarget(liveActive) : undefined}
        />
      )}

      {exitTarget && (
        <CardReturnConfirm
          visit={exitTarget}
          onConfirm={() => { void confirmExit(exitTarget); }}
          onClose={() => setExitTarget(null)}
        />
      )}
    </div>
  );
}
