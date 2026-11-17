import type { LoaderFunctionArgs } from "react-router";
import { requireStaff } from "../lib/staff.server";
import { flagsForLatestScan } from "../lib/flags.server";
import { applyQuery, CSV_HEADERS, csvRows, queryFromParams } from "../lib/flag-table";
import { csvResponse, toCsv } from "../lib/csv";

/** CSV of the flag queue, with the same sort and filters as the screen. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireStaff(request);
  const { scan, rows } = await flagsForLatestScan(shop);
  const q = queryFromParams(new URL(request.url).searchParams);
  return csvResponse(`flag-queue-scan-${scan?.id ?? "none"}.csv`, toCsv(CSV_HEADERS, csvRows(applyQuery(rows, q))));
};
