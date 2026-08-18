import { useState } from 'react';
import { supabase } from '../../supabaseClient';
import { safeErrorMessage } from '../../lib/errors';
import { sendOtpEmail } from '../../lib/otpDelivery';

// Where the gate OTP for an approved walk-in is emailed. On-prem this is the
// security desk's mailbox; the code also arrives as an in-app guard
// notification (migration 094) and is recorded in otp_deliveries.
const SECURITY_EMAIL = 'security-gate@securegate.local';

// Best-effort: dispatch the freshly-approved walk-in's OTP to security. Never
// throws — the notification + otp_deliveries log are the source of truth.
async function dispatchSecurityOtp(visitId: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('visits')
      .select('otp_code, ref_number, visitor:visitors(full_name)')
      .eq('id', visitId)
      .single();
    const otp = (data as any)?.otp_code as string | undefined;
    if (!otp) return;
    await sendOtpEmail({
      to: SECURITY_EMAIL,
      visitorName: (data as any)?.visitor?.full_name ?? 'Walk-in visitor',
      otp,
      refNumber: (data as any)?.ref_number ?? '',
      audience: 'security',
    });
  } catch {
    /* email is best-effort; ignore */
  }
}

// Takes no arguments: the only decisions left act on a single visit id, and
// the department scope is enforced inside the approve_visit / reject_visit
// SECURITY DEFINER RPCs. The old `deptId` parameter existed solely to scope
// the department-wide `cancel_all_pre_approved` call, which is gone.
export function useVisitDecisions() {
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const onReasonChange = (id: string, val: string) => setReasons((r) => ({ ...r, [id]: val }));

  const flash = (msg: string) => { setSuccessMsg(msg); setTimeout(() => setSuccessMsg(''), 4000); };

  const decide = async (visitId: string, approved: boolean) => {
    const reason = reasons[visitId]?.trim();
    if (!approved && !reason) { setError('Please enter a rejection reason.'); return; }
    setActing(visitId); setError('');
    try {
      const rpc = (supabase as any).rpc.bind(supabase);
      const { error: err } = approved
        ? await rpc('approve_visit', { visit_id: visitId })
        : await rpc('reject_visit', { visit_id: visitId, reason: reason || 'Rejected by HOD' });
      if (err) { setError(safeErrorMessage(err, 'Action failed.')); return; }
      if (approved) void dispatchSecurityOtp(visitId);
      flash(approved ? 'Visitor approved — OTP sent to security.' : 'Visit rejected.');
    } catch (err) { setError(safeErrorMessage(err, 'Action failed.')); }
    finally { setActing(null); }
  };

  // Approve and reject are the ONLY decisions an HOD makes on a visit. A
  // pre-approval is final once given: this hook used to also expose
  // `cancelVisit` (cancel_visit RPC, one visit) and `clearAllApproved`
  // (cancel_all_pre_approved RPC, the whole department's pre-approved list),
  // and both were removed on purpose. A visitor who has been told they are
  // cleared for entry must not be able to arrive at the gate and be turned
  // away by a decision reversed behind their back — if entry has to be
  // stopped, that is the guard's call at the gate, not a retroactive edit to
  // the approval. The RPCs and their RLS tests stay in the database (see
  // migration 045 and tests/security/rls.test.ts); do not re-expose them here.
  return {
    acting, error, successMsg, reasons,
    setError, setSuccessMsg, onReasonChange,
    decide,
  };
}
