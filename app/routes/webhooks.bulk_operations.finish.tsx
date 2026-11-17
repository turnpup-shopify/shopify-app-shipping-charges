import type { ActionFunctionArgs } from "react-router";
import { waitUntil } from "@vercel/functions";
import { authenticate } from "../shopify.server";
import { onBulkOperationFinished, processScan } from "../lib/scan/scan.server";

export const config = { maxDuration: 300 };

/**
 * Shopify calls this when a bulk operation finishes. Shopify expects a reply
 * within a few seconds, so we answer right away and keep processing in the
 * background with waitUntil (Vercel keeps the function alive until it's done
 * or hits maxDuration).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload } = await authenticate.webhook(request);
  const p = payload as { admin_graphql_api_id?: string; status?: string; error_code?: string | null };
  if (!p.admin_graphql_api_id || !p.status) return new Response();

  const scanId = await onBulkOperationFinished(p.admin_graphql_api_id, p.status, p.error_code);
  if (scanId) {
    waitUntil(processScan(scanId).catch((e) => console.error("processScan failed", e)));
  }
  return new Response();
};
