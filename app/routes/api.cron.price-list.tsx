import type { LoaderFunctionArgs } from "react-router";
import { isAuthorizedCron } from "../lib/cron.server";
import { SYSTEM_ACTOR } from "../lib/audit.server";
import { installedShops } from "../lib/scan/scan.server";
import { checkPriceList } from "../lib/price-list/price-list.server";

export const config = { maxDuration: 120 };

/**
 * Daily check of the Uttermost price list. Vercel Cron calls this with GET and
 * `Authorization: Bearer $CRON_SECRET`. Imports the file only if it changed.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request)) return new Response("Unauthorized", { status: 401 });
  const results: Record<string, unknown> = {};
  for (const shop of await installedShops()) {
    results[shop] = await checkPriceList(shop, "CRON", SYSTEM_ACTOR);
  }
  return Response.json(results);
};
