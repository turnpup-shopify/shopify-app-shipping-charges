import { useMemo, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireStaff } from "../lib/staff.server";
import { flagsForLatestScan } from "../lib/flags.server";
import {
  applyQuery,
  COLUMNS,
  DEFAULT_QUERY,
  queryFromParams,
  queryToParams,
  type FlagQuery,
  type SortKey,
} from "../lib/flag-table";
import { Explain } from "../components/Explain";
import { describeFix, downloadCsv, FIX_LABELS, formatDateTime, formatMoney, formatPct } from "../lib/format";
import { gidToId } from "../lib/scan/variant-line";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireStaff(request);
  const { scan, rows } = await flagsForLatestScan(shop);
  return {
    scan: scan && { id: scan.id, finishedAt: scan.finishedAt?.toISOString() ?? null },
    rows,
  };
};

const val = (e: Event) => (e.currentTarget as HTMLInputElement).value;

export default function FlagQueue() {
  const { scan, rows } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState<FlagQuery>(() => queryFromParams(params));
  const shopify = useAppBridge();

  const update = (patch: Partial<FlagQuery>) => {
    const next = { ...q, ...patch };
    setQ(next);
    setParams(queryToParams(next), { replace: true, preventScrollReset: true });
  };

  const visible = useMemo(() => applyQuery(rows, q), [rows, q]);
  const tiers = useMemo(() => [...new Set(rows.map((r) => r.tier))].sort(), [rows]);

  const sortBy = (key: SortKey) =>
    update({ sort: key, dir: q.sort === key && q.dir === "asc" ? "desc" : "asc" });
  const arrow = (key: SortKey) => (q.sort === key ? (q.dir === "asc" ? " ↑" : " ↓") : "");

  const exportCsv = async () => {
    try {
      const p = queryToParams(q).toString();
      await downloadCsv(`/app/flags.csv${p ? `?${p}` : ""}`, `flag-queue-scan-${scan?.id ?? "none"}.csv`);
    } catch (e) {
      shopify.toast.show(e instanceof Error ? e.message : "Export failed", { isError: true });
    }
  };

  return (
    <s-page heading="Flag queue" inlineSize="large">
      <s-button slot="primary-action" onClick={exportCsv} {...(!rows.length ? { disabled: true } : {})}>
        Export CSV
      </s-button>

      {!scan ? (
        <s-section>
          <s-paragraph>No scan has finished yet. Run one from the dashboard.</s-paragraph>
        </s-section>
      ) : (
        <>
          <s-section heading="Filters">
            <s-paragraph>
              From the scan finished {formatDateTime(scan.finishedAt)}. Showing {visible.length} of {rows.length}{" "}
              flagged variants. Click any column heading to sort; click again to reverse.
            </s-paragraph>
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
              <s-search-field label="Product" placeholder="Search titles" value={q.q} onInput={(e) => update({ q: val(e) })} />
              <s-select label="Status" value={q.severity} onChange={(e) => update({ severity: val(e) as FlagQuery["severity"] })}>
                <s-option value="">All</s-option>
                <s-option value="CRITICAL">Critical</s-option>
                <s-option value="FLAGGED">Flagged</s-option>
              </s-select>
              <s-select label="Tier" value={q.tier} onChange={(e) => update({ tier: val(e) })}>
                <s-option value="">All</s-option>
                {tiers.map((t) => (
                  <s-option key={t} value={t}>
                    {t}
                  </s-option>
                ))}
              </s-select>
              <s-select label="Suggested fix" value={q.fix} onChange={(e) => update({ fix: val(e) })}>
                <s-option value="">All</s-option>
                {Object.entries(FIX_LABELS)
                  .filter(([k]) => k !== "none")
                  .map(([k, label]) => (
                    <s-option key={k} value={k}>
                      {label}
                    </s-option>
                  ))}
              </s-select>
              <Range label="Price ($)" min={q.priceMin} max={q.priceMax} onChange={(a, b) => update({ priceMin: a, priceMax: b })} />
              <Range label="Cost ($)" min={q.costMin} max={q.costMax} onChange={(a, b) => update({ costMin: a, costMax: b })} />
              <Range label="Landed cost ($)" min={q.landedMin} max={q.landedMax} onChange={(a, b) => update({ landedMin: a, landedMax: b })} />
              <Range label="Margin (%)" min={q.marginMin} max={q.marginMax} onChange={(a, b) => update({ marginMin: a, marginMax: b })} />
              <s-checkbox
                label="Only items to exclude from discounts"
                checked={q.excludeOnly}
                onChange={(e) => update({ excludeOnly: (e.currentTarget as unknown as { checked: boolean }).checked })}
              />
              <s-button variant="tertiary" onClick={() => update(DEFAULT_QUERY)}>
                Clear filters
              </s-button>
            </s-grid>
          </s-section>

          <s-section padding="none">
            <s-table>
              <s-table-header-row>
                <s-table-header>Image</s-table-header>
                {COLUMNS.map((c) => (
                  <s-table-header key={c.key} {...(c.numeric ? { format: "numeric" } : {})}>
                    <s-clickable onClick={() => sortBy(c.key)} accessibilityLabel={`Sort by ${c.label}`}>
                      {c.label}
                      {arrow(c.key)}
                    </s-clickable>
                  </s-table-header>
                ))}
              </s-table-header-row>
              <s-table-body>
                {visible.map((r) => (
                  <s-table-row key={r.id}>
                    <s-table-cell>
                      <s-thumbnail src={r.imageUrl ?? ""} alt={r.title} size="small" />
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack gap="small-300">
                        <s-link href={`/app/products/${gidToId(r.variantId)}`}>{r.title}</s-link>
                        <s-badge tone={r.severity === "CRITICAL" ? "critical" : "warning"}>
                          {r.severity === "CRITICAL" ? "Critical" : "Flagged"}
                        </s-badge>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <Explain value={formatMoney(r.priceCents)} label="Price" how="The variant's current selling price in Shopify." />
                    </s-table-cell>
                    <s-table-cell>
                      <Explain value={formatMoney(r.unitCostCents)} label="Unit cost" how="The inventory item's cost in Shopify." />
                    </s-table-cell>
                    <s-table-cell>
                      <Explain
                        value={r.tier}
                        label="Freight tier"
                        how={`${r.tier} freight comes to ${formatMoney(r.freightCents)} for this item. Open the product to see the size and weight math.`}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <Explain
                        value={formatMoney(r.landedCostCents)}
                        label="Landed cost"
                        how={`Unit cost ${formatMoney(r.unitCostCents)} + freight ${formatMoney(r.freightCents)}.`}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <Explain
                        value={formatPct(r.marginPct)}
                        label="Margin after freight"
                        tone={r.marginCents < 0 ? "critical" : undefined}
                        how={`(Price ${formatMoney(r.priceCents)} − landed cost ${formatMoney(r.landedCostCents)}) ÷ price = ${formatMoney(r.marginCents)} ÷ ${formatMoney(r.priceCents)} = ${formatPct(r.marginPct)}.`}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <Explain
                        value={describeFix(r.suggestedFix, r.excludeFromDiscounts)}
                        label="Suggested fix"
                        how={
                          (r.suggestedFix === "reprice" && r.suggestedValueCents != null
                            ? `Raise the price to ${formatMoney(r.suggestedValueCents)}.`
                            : r.suggestedFix === "surcharge" && r.suggestedValueCents != null
                              ? `Add a freight surcharge of ${formatMoney(r.suggestedValueCents)}.`
                              : "Repricing or a surcharge would be too large, so consider showroom only or delisting.") +
                          (r.excludeFromDiscounts ? ` It loses money at the max discount (${formatPct(r.marginAtDiscountPct)}), so also exclude it from discounts.` : "") +
                          " Open the product for the full math."
                        }
                      />
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            {visible.length === 0 ? (
              <s-box padding="base">
                <s-paragraph>No flagged variants match these filters.</s-paragraph>
              </s-box>
            ) : null}
          </s-section>
        </>
      )}
    </s-page>
  );
}

function Range({
  label,
  min,
  max,
  onChange,
}: {
  label: string;
  min: string;
  max: string;
  onChange: (min: string, max: string) => void;
}) {
  return (
    <s-grid gridTemplateColumns="1fr 1fr" gap="small-200">
      <s-number-field label={`${label} from`} value={min} onInput={(e) => onChange(val(e), max)} />
      <s-number-field label="to" value={max} onInput={(e) => onChange(min, val(e))} />
    </s-grid>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
