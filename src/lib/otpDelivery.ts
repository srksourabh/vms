// Client-side OTP dispatch. The OTP itself is minted and logged server-side
// (migrations 094/095, table otp_deliveries). This helper triggers the actual
// email through the on-prem mail relay exposed by the dev/admin proxy at
// /api/send-email (Mailpit locally; the customer's SMTP relay in production).
//
// Email is best-effort: the code is also shown on screen and recorded in
// otp_deliveries, so a mail failure never blocks the flow. SMS on an air-gapped
// site goes through a local GSM gateway; here it is recorded in the dispatch
// log and read out from the confirmation screen.

export type OtpEmailInput = {
  to: string;
  visitorName: string;
  otp: string;
  refNumber: string;
  hostName?: string | null;
  audience?: 'visitor' | 'security';
};

export async function sendOtpEmail(input: OtpEmailInput): Promise<boolean> {
  const { to, visitorName, otp, refNumber, hostName, audience = 'visitor' } = input;
  const subject =
    audience === 'security'
      ? `Gate OTP ${otp} — walk-in approved`
      : `Your visit OTP: ${otp}`;
  const lines =
    audience === 'security'
      ? [
          `A walk-in visitor (${visitorName}) has been approved.`,
          ``,
          `Gate OTP: ${otp}`,
          `Reference: ${refNumber}`,
          ``,
          `Enter this OTP at the gate to check the visitor in.`,
          ``,
          `— Secure Gate VMS`,
        ]
      : [
          `Hello ${visitorName},`,
          ``,
          `You have been pre-registered for a visit${hostName ? ` with ${hostName}` : ''}.`,
          ``,
          `Your One-Time Passcode (OTP) is: ${otp}`,
          `Reference: ${refNumber}`,
          ``,
          `Please tell security this OTP at the gate to be checked in.`,
          ``,
          `— Secure Gate VMS`,
        ];
  try {
    const res = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, text: lines.join('\n') }),
    });
    const data = await res.json().catch(() => ({}));
    return !!data?.success;
  } catch {
    return false;
  }
}
