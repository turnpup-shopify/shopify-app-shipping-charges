import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { requireStaff } from "../lib/staff.server";
import { auditWhere, listAudit } from "../lib/audit.server";
import { EVENT_LABELS } from "../lib/labels";
import { filterFromParams } from "../lib/activity.server";
import { downloadCsv, formatDateTime } from "../lib/format";
import { gidToId } from "../lib/scan/variant-line";

const PAGE = 100;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireStaff(request);
  const params = new URL(request.url).searchParams;
  const f = filterFromParams(params);
  const page = Math.max(1, Number(params.get("page") || 1));
  const [rows, total, actors] = await Promise.all([
    listAudit(shop, f, PAGE, (page - 1) * PAGE),
    prisma.auditLog.count({ where: auditWhere(shop, f) }),
    prisma.auditLog.findMany({
      where: { shop },
      distinct: ["actorId"],
      select: { actorId: true, actorName: true },
      orderBy: { actorName: "asc" },
    }),
  ]);
  return {
    filter: f.raw,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE)),
    total,
    actors,
    rows: rows.map((r) => ({
      id: String(r.id),
      at: r.at.toISOString(),
      actorName: r.actorName,
      event: EVENT_LABELS[r.eventType] ?? r.eventType,
      productId: r.productId,
      details: describe(r.eventType, r.after, r.inputs),
      reason: r.reason,
    })),
  };
};

function describe(type: string, after: unknown, inputs: unknown): string {
  const a = (after ?? {}) as Record<string, unknown>;
  const i = (inputs ?? {}) as Record<string, unknown>;
  switch (type) {
    case "scan_started":
      return `Scan ${i.scanId} (${i.trigger === "CRON" ? "nightly" : "manual"}), settings version ${i.settingsVersionId}`;
    case "scan_finished":
      return `Scan ${i.scanId}: ${a.variantsScanned} variants checked, ${a.flagsFound} flagged`;
    case "scan_failed":
      return `Scan ${i.scanId}: ${a.error}`;
    case "flag_written":
      return `${a.severity === "critical" ? "Critical" : "Flagged"} in scan ${a.scanId}, margin ${
        typeof a.marginPct === "number" ? `${(a.marginPct * 100).toFixed(1)}%` : "?"
      }`;
    case "settings_changed":
      return `New settings version ${a.settingsVersionId}`;
    case "role_changed":
      return `${a.name} is now ${String(a.role).toLowerCase()}`;
    case "staff_added":
      return `${a.name} added as ${String(a.role).toLowerCase()}`;
    case "price_list_imported":
      return `Version ${a.importId}: ${a.fileName}, ${a.rows} items (${i.trigger === "CRON" ? "daily check" : "manual"})`;
    case "price_list_check_failed":
      return `Couldn't import the price list (${i.trigger === "CRON" ? "daily check" : "manual"})`;
    case "price_list_source_changed":
      return `New link: ${a.url}`;
    default:
      return "";
  }
}

export default function Activity() {
  const { filter, rows, page, pages, total, actors } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [f, setF] = useState(filter);

  const qs = (extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, v);
    return p.toString();
  };
  const apply = (next = f) => {
    setF(next);
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    navigate(`/app/activity?${p.toString()}`);
  };
  const val = (e: Event) => (e.currentTarget as HTMLInputElement).value;

  return (
    <s-page heading="Activity log" inlineSize="large">
      <s-button
        slot="primary-action"
        onClick={() =>
          downloadCsv(`/app/activity.csv?${qs()}`, "activity-log.csv").catch((e) =>
            shopify.toast.show(String(e.message ?? e), { isError: true }),
          )
        }
      >
        Export CSV
      </s-button>

      <s-section heading="Filters">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
          <s-select label="Person" value={f.actor} onChange={(e) => apply({ ...f, actor: val(e) })}>
            <s-option value="">Everyone</s-option>
            {actors.map((a) => (
              <s-option key={a.actorId} value={a.actorId}>
                {a.actorName}
              </s-option>
            ))}
          </s-select>
          <s-text-field
            label="Product ID"
            placeholder="e.g. 8123456789"
            value={f.product}
            onChange={(e) => apply({ ...f, product: val(e) })}
          />
          <s-select label="Event" value={f.event} onChange={(e) => apply({ ...f, event: val(e) })}>
            <s-option value="">All events</s-option>
            {Object.entries(EVENT_LABELS).map(([k, v]) => (
              <s-option key={k} value={k}>
                {v}
              </s-option>
            ))}
          </s-select>
          <s-date-field label="From" value={f.from} onChange={(e) => apply({ ...f, from: val(e) })} />
          <s-date-field label="To" value={f.to} onChange={(e) => apply({ ...f, to: val(e) })} />
          <s-button variant="tertiary" onClick={() => apply({ actor: "", product: "", event: "", from: "", to: "" })}>
            Clear filters
          </s-button>
        </s-grid>
      </s-section>

      <s-section padding="none">
        <s-table
          paginate
          hasPreviousPage={page > 1}
          hasNextPage={page < pages}
          onPreviousPage={() => navigate(`/app/activity?${qs({ page: String(page - 1) })}`)}
          onNextPage={() => navigate(`/app/activity?${qs({ page: String(page + 1) })}`)}
        >
          <s-table-header-row>
            <s-table-header>When (Central)</s-table-header>
            <s-table-header>Who</s-table-header>
            <s-table-header>Event</s-table-header>
            <s-table-header>Product</s-table-header>
            <s-table-header>Details</s-table-header>
            <s-table-header>Reason</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => (
              <s-table-row key={r.id}>
                <s-table-cell>{formatDateTime(r.at)}</s-table-cell>
                <s-table-cell>{r.actorName}</s-table-cell>
                <s-table-cell>{r.event}</s-table-cell>
                <s-table-cell>
                  {r.productId ? (
                    <s-link href={`/app/activity?${qs({ product: gidToId(r.productId), page: "" })}`}>
                      {gidToId(r.productId)}
                    </s-link>
                  ) : (
                    ""
                  )}
                </s-table-cell>
                <s-table-cell>{r.details}</s-table-cell>
                <s-table-cell>{r.reason ?? ""}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-box padding="base">
          <s-text color="subdued">
            {total} entries. Page {page} of {pages}. Newest first. This log can’t be edited or deleted.
          </s-text>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
