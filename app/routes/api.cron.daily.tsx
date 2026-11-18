import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { isAuthorizedCron } from "../lib/cron.server";
import { appendAudit, EVENT_TYPES, SYSTEM_ACTOR } from "../lib/audit.server";
import { installedShops } from "../lib/scan/scan.server";
import { checkPriceList } from "../lib/price-list/price-list.server";
import { runShippingCheck } from "../lib/shipping/shipping-check.server";
import { adminAppUrl, buildDailyEmail } from "../lib/daily-report";
import { sendEmail } from "../lib/notify.server";

export const config = { maxDuration: 300 };

/**
 * Daily checks (Vercel Cron, 12:00 UTC). For each shop:
 *  1. Uttermost price list: imports only if Dropbox has a new version.
 *  2. Shipping profiles: compares Shipping Method tags with the Freight profile.
 * Sends one email only when something changed; a quiet day sends nothing.
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
      shipping = { changed: outcome.changed, drift: outcome.drift };
      checkId = outcome.check.id;
    } catch (e) {
      shipping = { error: e instanceof Error ? e.message : String(e) };
    }

    const email = buildDailyEmail({ shop, appUrl: (p) => adminAppUrl(shop, p), priceList, shipping });
    let emailResult: unknown = "nothing changed";
    if (email) {
      const sent = await sendEmail(email).catch((e) => ({ sent: false as const, reason: String(e) }));
      emailResult = sent;
      if (sent.sent) {
        await appendAudit({ shop, actor: SYSTEM_ACTOR, eventType: EVENT_TYPES.notificationSent, after: { subject: email.subject } });
        if (checkId) await prisma.shippingCheck.update({ where: { id: checkId }, data: { notifiedAt: new Date() } });
      } else {
        console.error("Daily email not sent:", sent.reason);
      }
    }

    results[shop] = {
      priceList: priceList.status,
      shipping: "error" in shipping ? { error: shipping.error } : { changed: shipping.changed },
      email: emailResult,
    };
  }
  return Response.json(results);
};
