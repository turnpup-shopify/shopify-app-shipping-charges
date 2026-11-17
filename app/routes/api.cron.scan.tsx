import type { LoaderFunctionArgs } from "react-router";
import { waitUntil } from "@vercel/functions";
import { isAuthorizedCron } from "../lib/cron.server";
import { SYSTEM_ACTOR } from "../lib/audit.server";
import {
  installedShops,
  processScan,
  recoverStuckScans,
  ScanAlreadyRunningError,
  startScan,
} from "../lib/scan/scan.server";

export const config = { maxDuration: 300 };

/**
 * Nightly scan. Vercel Cron calls this with GET and
 * `Authorization: Bearer $CRON_SECRET`. It starts a bulk query per installed
 * shop and returns right away; the bulk_operations/finish webhook does the rest.
 * It also resumes any scan that got stuck.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request)) return new Response("Unauthorized", { status: 401 });

  const results: Record<string, unknown> = {};
  for (const shop of await installedShops()) {
    try {
      const resumed = await recoverStuckScans(shop);
      for (const id of resumed) {
        waitUntil(processScan(id).catch((e) => console.error("processScan failed", e)));
      }
      if (resumed.length) {
        results[shop] = { resumed };
        continue;
      }
      const scan = await startScan(shop, "CRON", SYSTEM_ACTOR);
      results[shop] = { started: scan.id };
    } catch (e) {
      results[shop] =
        e instanceof ScanAlreadyRunningError
          ? { skipped: `scan ${e.scan.id} already running` }
          : { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return Response.json(results);
};
