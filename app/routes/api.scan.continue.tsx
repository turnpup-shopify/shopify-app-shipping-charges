import type { ActionFunctionArgs } from "react-router";
import { waitUntil } from "@vercel/functions";
import { processScan } from "../lib/scan/scan.server";
import { isAuthorizedCron } from "../lib/cron.server";

export const config = { maxDuration: 300 };

/** Picks up a large scan where the previous invocation stopped. Internal only. */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthorizedCron(request)) return new Response("Unauthorized", { status: 401 });
  const { scanId } = (await request.json().catch(() => ({}))) as { scanId?: number };
  if (!Number.isInteger(scanId)) return new Response("scanId required", { status: 400 });
  waitUntil(processScan(scanId!).catch((e) => console.error("processScan failed", e)));
  return Response.json({ accepted: true }, { status: 202 });
};

export const loader = () => new Response("Method not allowed", { status: 405 });
