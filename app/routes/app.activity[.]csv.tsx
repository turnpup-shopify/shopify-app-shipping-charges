import type { LoaderFunctionArgs } from "react-router";
import { requireStaff } from "../lib/staff.server";
import { listAudit } from "../lib/audit.server";
import { filterFromParams } from "../lib/activity.server";
import { csvResponse, toCsv } from "../lib/csv";

/** CSV of the activity log with the current filters, newest first. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireStaff(request);
  const f = filterFromParams(new URL(request.url).searchParams);
  const rows = await listAudit(shop, f, 50_000);
  const j = (v: unknown) => (v == null ? "" : JSON.stringify(v));
  return csvResponse(
    "activity-log.csv",
    toCsv(
      ["At (UTC)", "Actor ID", "Actor name", "Event", "Product ID", "Before", "After", "Inputs", "Reason"],
      rows.map((r) => [
        r.at.toISOString(),
        r.actorId,
        r.actorName,
        r.eventType,
        r.productId,
        j(r.before),
        j(r.after),
        j(r.inputs),
        r.reason,
      ]),
    ),
  );
};
