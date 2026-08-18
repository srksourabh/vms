import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../supabaseClient';
import { normalizePhone, isBlacklisted } from '../../lib/blacklist';
import { validatePreApproval } from '../../lib/visitLifecycle';
import { istLocalToUtcIso } from '../../lib/istDateTime';
import { safeErrorMessage } from '../../lib/errors';
import { attachHostNames } from '../../lib/hostNames';
import { useDepartments } from '../../lib/useDepartments';
import { sendOtpEmail } from '../../lib/otpDelivery';
import type { Visit, VisitorPurpose } from '../../types/index';
import SuccessPopup from '../../components/SuccessPopup';
import PreApprovalPass from '../../components/PreApprovalPass';
import DateTimeField from '../../components/DateTimeField';

const PURPOSES: { value: VisitorPurpose; label: string }[] = [
  { value: 'meeting',     label: 'Meeting' },
  { value: 'vendor',      label: 'Vendor / Contractor' },
  { value: 'interview',   label: 'Interview' },
  { value: 'delivery',    label: 'Delivery / Courier' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'audit',       label: 'Audit / Inspection' },
  { value: 'other',       label: 'Other' },
];

type Props = { onPreApproved: (name: string, refNumber: string) => void };

export default function PreApproveForm({ onPreApproved }: Props): React.ReactElement {
  const { departments } = useDepartments();
  const [blacklist,   setBlacklist]   = useState<{ phone: string; reason: string }[]>([]);

  const [phone,       setPhone]       = useState('');
  const [fullName,    setFullName]    = useState('');
  const [vendorName,     setVendorName]     = useState('');
  const [email,       setEmail]       = useState('');
  const [purpose,     setPurpose]     = useState<VisitorPurpose>('meeting');
  const [deptId,      setDeptId]      = useState('');
  const [hostId,      setHostId]      = useState('');
  // NOTE: vehicle registration intentionally removed per client instruction
  // (no driver/vehicle management for this mall deployment).

  const [blacklistHit,    setBlacklistHit]    = useState<string | null>(null);
  const [submitting,      setSubmitting]      = useState(false);
  const [error,           setError]           = useState('');
  const [userRole,        setUserRole]        = useState<string>('');
  const [userDept,        setUserDept]        = useState<string>('');
  const [scheduledFor,    setScheduledFor]    = useState<string>('');
  const [expectedDeparture, setExpectedDeparture] = useState<string>('');
  const [successPopup,    setSuccessPopup]    = useState<{ title: string; refNumber: string } | null>(null);
  const [otp,             setOtp]             = useState<string | null>(null);
  const [otpEmailStatus,  setOtpEmailStatus]  = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [passVisit,       setPassVisit]       = useState<Visit | null>(null);
  const [activeVisitCheck, setActiveVisitCheck] = useState<{ checking: boolean; message: string | null }>({ checking: false, message: null });

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const user = data.user;
      const meta = user?.app_metadata ?? {};
      setUserRole((meta.role as string) ?? '');
      const dept = (meta.department_id as string) ?? '';
      setUserDept(dept);
      if (dept) setDeptId(dept);
      if (user?.id) setHostId(user.id);
    });
    supabase.from('visitors').select('phone, blacklist_reason').eq('is_blacklisted', true).then(({ data }) => {
      setBlacklist((data ?? []).map((r) => ({ phone: r.phone, reason: r.blacklist_reason ?? 'Flagged' })));
    });
  }, []);

  const recallByPhone = useCallback(async () => {
    if (!phone) return;
    let normalized: string;
    try { normalized = normalizePhone(phone); } catch { return; }
    const hit = isBlacklisted(phone, blacklist);
    if (hit) { setBlacklistHit(hit.reason); return; }
    setBlacklistHit(null);
    const { data } = await supabase.from('visitors').select('*').eq('phone', normalized).maybeSingle();
    if (data) {
      setFullName(data.full_name);
      setVendorName(data.vendor_name ?? '');
      if (data.email) setEmail(data.email);
    }
  }, [phone, blacklist]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    // A datetime-local input yields a bare wall-clock string with NO timezone
    // ("2026-08-11T22:00"). It used to go straight to the RPC, where Postgres
    // cast it in the session timezone — UTC — so an HOD booking 10 PM tonight
    // stored 22:00Z and every IST screen read it back as 03:30 the NEXT
    // morning: every booking shifted by +5h30m. This deployment is IST-only,
    // so the typed value is IST by definition and is converted here, once,
    // before validation as well as before the write — validating the raw
    // string would compare a different instant than the one being stored.
    const scheduledUtc = istLocalToUtcIso(scheduledFor);
    const departureUtc = istLocalToUtcIso(expectedDeparture);
    const validationError = validatePreApproval({
      department_id: deptId, purpose, scheduled_for: scheduledUtc ?? '',
      expected_departure: departureUtc ?? '',
    });
    if (validationError) { setError(validationError); return; }
    if (blacklistHit) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setError('Session expired — please log in again.'); return; }
    setSubmitting(true);
    try {
      let normalized: string;
      try { normalized = normalizePhone(phone); } catch { throw new Error('Please enter a valid 10-digit mobile number (e.g. +91 98765 43210).'); }
      // SEC-17: Check for existing active visit before pre-approval
      setActiveVisitCheck({ checking: true, message: null });
      const { data: existingVisit } = await (supabase as any)
        .rpc('get_active_visit_for_phone', { p_phone: normalized });
      if (existingVisit) {
        setActiveVisitCheck({ checking: false, message: `This phone number already has an active visit (Ref: ${existingVisit.ref_number}, Status: ${existingVisit.status.replace(/_/g, ' ')}). Cannot pre-approve.` });
        setSubmitting(false);
        return;
      }
      setActiveVisitCheck({ checking: false, message: null });
      // Use security definer RPC to bypass RLS
      const params: Record<string, any> = {
        p_phone: normalized,
        p_full_name: fullName,
        p_vendor_name: vendorName || null,
        p_department_id: deptId,
        p_host_id: hostId,
        p_purpose: purpose,
      };
      if (scheduledUtc) params.p_scheduled_for = scheduledUtc;
      if (departureUtc) params.p_expected_departure = departureUtc;
      if (email.trim()) params.p_email = email.trim();
      const { data: result, error: rpcErr } = await (supabase as any)
        .rpc('pre_approve_visitor_v2', params);
      if (rpcErr) throw rpcErr;
      if (!result?.ref_number) throw new Error('Failed to create pre-approved visit.');
      // The visit OTP (server-minted) is what the visitor tells the guard at
      // the gate. Show it, and dispatch it by email through the on-prem relay.
      const otpCode: string | null = result.otp_code ?? null;
      setOtp(otpCode);
      if (otpCode && email.trim()) {
        setOtpEmailStatus('sending');
        void sendOtpEmail({ to: email.trim(), visitorName: fullName, otp: otpCode, refNumber: result.ref_number })
          .then((ok) => setOtpEmailStatus(ok ? 'sent' : 'failed'))
          .catch(() => setOtpEmailStatus('failed'));
      } else {
        setOtpEmailStatus('idle');
      }
      // The pass preview is a bonus for handoff/testing, not the point of
      // pre-approval — a failed fetch here must never block or error out a
      // pre-approval that has already succeeded.
      try {
        const { data: visitRow } = await supabase
          .from('visits')
          .select(`*, visitor:visitors(*), department:departments(id, name, code, created_at)`)
          .eq('ref_number', result.ref_number)
          .single();
        if (visitRow) {
          const [withHost] = await attachHostNames([visitRow as unknown as Visit]);
          setPassVisit(withHost ?? (visitRow as unknown as Visit));
        }
      } catch { setPassVisit(null); }
      setSuccessPopup({ title: 'Visitor Pre-Approved', refNumber: result.ref_number });
    } catch (err) { setError(safeErrorMessage(err, 'Pre-approval failed. Please try again.')); }
    finally { setSubmitting(false); }
  };

  const handlePopupClose = useCallback(() => {
    setSuccessPopup(null);
    setPassVisit(null);
    setOtp(null);
    setOtpEmailStatus('idle');
    if (successPopup) {
      onPreApproved(fullName, successPopup.refNumber);
    }
  }, [successPopup, fullName, onPreApproved]);

  return (
    <form onSubmit={handleSubmit} className="card-premium p-6 sm:p-8 space-y-6 max-w-2xl animate-fade-in">
      <div className="flex items-start gap-3.5">
        <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-white flex items-center justify-center shadow-glow-sm ring-1 ring-white/20 shrink-0">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM3 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 019.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
          </svg>
        </div>
        <div>
          <h2 className="text-lg font-bold text-navy-950 dark:text-white font-display tracking-tight">Pre-Approve Visitor</h2>
          <p className="text-sm text-navy-500 dark:text-navy-400 mt-1">Pre-register a visitor — they will be pre-approved and can be checked in at the gate without waiting</p>
        </div>
      </div>

      {blacklistHit && (
        <div className="rounded-xl border-2 border-danger-500/30 bg-danger-50 p-4 flex items-start gap-3 animate-fade-in">
          <div className="shrink-0 h-8 w-8 rounded-lg bg-danger-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-danger-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
          </div>
          <div>
            <p className="font-bold text-danger-700">BLACKLISTED — Do not pre-approve</p>
            <p className="text-sm text-danger-600 mt-0.5">Reason: {blacklistHit}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
        <div>
          <label className="label">Mobile Number *</label>
          <input type="tel" required maxLength={20} value={phone}
            onChange={(e) => { setPhone(e.target.value); setBlacklistHit(null); }}
            onBlur={recallByPhone} placeholder="+91 98765 43210" className="input" />
        </div>
        <div><label className="label">Visitor Name *</label><input type="text" required value={fullName} onChange={(e) => setFullName(e.target.value)} className="input" /></div>
        <div><label className="label">Vendor Name / Coming from *</label><input type="text" required value={vendorName} onChange={(e) => setVendorName(e.target.value)} className="input" /></div>
        <div><label className="label">Email (for OTP)</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="visitor@example.com" className="input" /></div>
        <div>
          <label className="label">Purpose *</label>
          <select required value={purpose} onChange={(e) => setPurpose(e.target.value as VisitorPurpose)} className="input">
            {PURPOSES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        {userRole === 'admin' && (
          <div>
            <label className="label">Department *</label>
            <select required value={deptId} onChange={(e) => setDeptId(e.target.value)} className="input">
              <option value="">Select department</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        )}

        <div className="sm:col-span-2">
          <DateTimeField
            id="scheduled-for"
            label="Schedule for *"
            required
            value={scheduledFor}
            onChange={setScheduledFor}
          />
        </div>
        {/* Optional, and it must stay optional. Requiring it would put a second
            mandatory datetime in front of every routine meeting to serve the
            minority case, and an approver who does not know would type something
            false — worse than null, which is at least honest about not knowing.
            Left blank, the overstay rule falls back to a fixed interval from
            check-in; filled in, this IS the deadline. */}
        <div className="sm:col-span-2">
          <DateTimeField
            id="expected-departure"
            label="Expected departure (optional)"
            value={expectedDeparture}
            min={scheduledFor || undefined}
            onChange={setExpectedDeparture}
            hint="Set this for visits running overnight or across several days, so the visitor is not flagged as overstaying while they are still expected on site."
          />
        </div>
      </div>

      {successPopup && (
        <SuccessPopup title={successPopup.title} onClose={handlePopupClose}>
          {otp && (
            <div className="mb-4 rounded-xl border-2 border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 p-4 text-center">
              <p className="text-xs font-semibold uppercase tracking-wide text-navy-600 dark:text-navy-300">Visitor OTP</p>
              <p className="text-3xl font-black tracking-[0.3em] text-brand-700 dark:text-brand-300 mt-1">{otp}</p>
              <p className="text-xs text-navy-600 dark:text-navy-400 mt-2">
                Sent by SMS to <span className="font-semibold">{phone || 'the visitor'}</span>
                {email.trim() && (
                  <> and by email to <span className="font-semibold">{email.trim()}</span>{' '}
                    {otpEmailStatus === 'sending' && <span className="text-navy-400">(sending…)</span>}
                    {otpEmailStatus === 'sent' && <span className="text-emerald-600">(email sent)</span>}
                    {otpEmailStatus === 'failed' && <span className="text-amber-600">(email queued — relay offline)</span>}
                  </>
                )}
              </p>
              <p className="text-xs text-navy-500 dark:text-navy-400 mt-1">The visitor gives this OTP to security at the gate.</p>
            </div>
          )}
          {passVisit && <PreApprovalPass visit={passVisit} showIdProof={false} />}
        </SuccessPopup>
      )}

      {error && (
        <div className="alert-error">
          <svg className="w-4 h-4 text-danger-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
          {error}
        </div>
      )}

      {activeVisitCheck.message && (
        <div className="alert-warning">
          <svg className="w-4 h-4 text-warning-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
          <span className="flex-1">{activeVisitCheck.message}</span>
          <button onClick={() => setActiveVisitCheck({ checking: false, message: null })} className="text-warning-500 hover:text-warning-700 text-xs font-medium ml-auto">Dismiss</button>
        </div>
      )}

      <button type="submit" disabled={submitting || !!blacklistHit}
        className="btn-primary w-full !py-3.5">
        {submitting ? 'Submitting...' : 'Pre-Approve Visitor'}
      </button>

      <p className="text-xs text-navy-300 text-center">Pre-approved visitors skip the approval queue at entry</p>
    </form>
  );
}
