/**
 * Sends notification emails through Resend (https://resend.com).
 *
 * Env:
 *   RESEND_API_KEY  required to send; without it, emails are skipped and logged
 *   NOTIFY_EMAIL    who gets them, comma separated
 *   NOTIFY_FROM     optional sender, default "Freight Margin Guard <onboarding@resend.dev>"
 *                   (resend.dev only delivers to the Resend account's own address;
 *                   use a verified domain to send to anyone else)
 */
export interface Email {
  subject: string;
  text: string;
  html: string;
}

export type SendResult = { sent: true; id: string | null } | { sent: false; reason: string };

export function notifyRecipients(): string[] {
  return (process.env.NOTIFY_EMAIL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function sendEmail(email: Email): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  const to = notifyRecipients();
  if (!key) return { sent: false, reason: "RESEND_API_KEY is not set." };
  if (to.length === 0) return { sent: false, reason: "NOTIFY_EMAIL is not set." };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.NOTIFY_FROM || "Freight Margin Guard <onboarding@resend.dev>",
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok) return { sent: false, reason: `Resend answered ${res.status}: ${body.message ?? res.statusText}` };
  return { sent: true, id: body.id ?? null };
}
