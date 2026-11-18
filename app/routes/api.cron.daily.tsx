import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { isAuthorizedCron } from "../lib/cron.server";
import { appendAudit, EVENT_TYPES, SYSTEM_ACTOR } from "../lib/audit.server";
import { installedShops } from "../lib/scan/scan.server";
import { checkPriceList } from "../lib/price-list/price-list.server";
import { runShippingCheck } from "../lib/shipping/shipping-check.server";
import { needsAttention } from "../lib/shipping/drift";
import { adminAppUrl, buildDailyEmail } from "../lib/daily-report";
import { sendEmail } from "../lib/notify.server";

export const config = { maxDuration: 300 };

/**
 * Daily checks (Vercel Cron, 12:00 UTC). For each shop:
 *  1. Uttermost price list: imports only if Dropbox has a new version.
 *  2. Shipping profiles: compares Shipping Method tags with the Freight profile.
 * Sends one email only when there is something new: a new price list, a failed
 * check, or shipping problems that haven't been emailed yet (whether the daily
 * job or someone's "Check now" found them). A quiet day sends nothing, and the
 * same unresolved problem isn't emailed twice.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request)) return new Response("Unauthorized", { status: 401 });

  const results: Record<string, unknown> = {};
  for (const shop of await installedShops()) {
    const priceList = await checkPriceList(shop, "CRON", SYSTEM_ACTOR);

    let shipping: Parameters<typeof buildDailyEmail>[0]["shipping"];
    let checkId: number | null = null;
    try {
      const outcome = await runShippingCheck(shop, "CRON", SYSTEM_ACTOR);
      // Each distinct state is one row; once its email has gone out it has
      // notifiedAt set and won't be sent again.
      shipping = { notify: !outcome.check.notifiedAt && needsAttention(outcome.drift), drift: outcome.drift };
      checkId = outcome.check.id;
    } catch (e) {
      shipping = { error: e instanceof Error ? e.message : String(e) };
    }

    const email = buildDailyEmail({ shop, appUrl: (p) => adminAppUrl(shop, p), priceList, shipping });
    let emailResult: unknown = "nothing new";
    if (email) {
      const sent = await sendEmail(email).catch((e) => ({ sent: false as const, reason: String(e) }));
      emailResult = sent;
      if (sent.sent) {
        console.log(`Daily email sent to NOTIFY_EMAIL: ${email.subject}`);
        await appendAudit({ shop, actor: SYSTEM_ACTOR, eventType: EVENT_TYPES.notificationSent, after: { subject: email.subject } });
        if (checkId) await prisma.shippingCheck.update({ where: { id: checkId }, data: { notifiedAt: new Date() } });
      } else {
        console.error("Daily email not sent:", sent.reason);
      }
    }

    console.log(`Daily check ${shop}: price list ${priceList.status}, email ${email ? "attempted" : "not needed"}`);
    results[shop] = {
      priceList: priceList.status,
      shipping: "error" in shipping ? { error: shipping.error } : { notify: shipping.notify },
      email: emailResult,
    };
  }
  return Response.json(results);
};
