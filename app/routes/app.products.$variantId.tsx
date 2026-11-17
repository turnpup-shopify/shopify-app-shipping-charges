import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { requireStaff } from "../lib/staff.server";
import { getCurrentSettings } from "../lib/settings.server";
import { evaluateVariant, type ReceiptLine } from "../lib/freight/engine";
import { parseVariantLine, type BulkVariantLine } from "../lib/scan/variant-line";
import { VARIANT_DETAIL_QUERY } from "../lib/scan/queries";
import { EVENT_LABELS } from "../lib/labels";
import { Receipt } from "../components/Receipt";
import { describeFix, formatDateTime, MISSING_LABELS, adminProductUrl } from "../lib/format";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop, admin } = await requireStaff(request);
  const variantGid = `gid://shopify/ProductVariant/${params.variantId}`;

  // Live read (read only), evaluated with today's settings.
  const res = await admin.graphql(VARIANT_DETAIL_QUERY, { variables: { id: variantGid } });
  const json = (await res.json()) as { data?: { productVariant: BulkVariantLine | null } };
  const parsed = json.data?.productVariant ? parseVariantLine(json.data.productVariant) : null;
  if (!parsed) throw new Response("Variant not found", { status: 404 });

  const { row, settings } = await getCurrentSettings(shop);
  const live = evaluateVariant(parsed.inputs, settings);

  // What the latest scan recorded for this variant, if it was flagged.
  const lastFlag = await prisma.flag.findFirst({
    where: { variantId: variantGid, scan: { shop, status: "FINISHED" } },
    orderBy: { scan: { startedAt: "desc" } },
    include: { scan: { select: { id: true, finishedAt: true, settingsVersionId: true } } },
  });

  const history = await prisma.auditLog.findMany({
    where: { shop, productId: parsed.productId },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: 100,
  });

  return {
    product: {
      title: parsed.productTitle,
      variantTitle: parsed.variantTitle,
      sku: parsed.sku,
      imageUrl: parsed.imageUrl,
      productId: parsed.productId,
      rawMetafields: parsed.rawMetafields,
    },
    settingsVersionId: row.id,
    live: {
      status: live.status,
      lines: live.lines,
      warnings: live.warnings,
      missing: live.status === "incomplete" ? live.missing : [],
      fix: live.status === "complete" ? describeFix(live.suggestedFix, live.excludeFromDiscounts) : null,
      severity: live.status === "complete" ? live.severity : null,
    },
    lastFlag: lastFlag && {
      scanId: lastFlag.scan.id,
      finishedAt: lastFlag.scan.finishedAt?.toISOString() ?? null,
      settingsVersionId: lastFlag.scan.settingsVersionId,
      lines: (lastFlag.snapshot as { lines?: ReceiptLine[] }).lines ?? [],
    },
    history: history.map((h) => ({
      id: String(h.id),
      at: h.at.toISOString(),
      actorName: h.actorName,
      event: EVENT_LABELS[h.eventType] ?? h.eventType,
      after: h.after,
    })),
  };
};

export default function ProductDetail() {
  const { product, live, lastFlag, history, settingsVersionId } = useLoaderData<typeof loader>();
  const name = product.variantTitle ? `${product.title} – ${product.variantTitle}` : product.title;

  return (
    <s-page heading={name}>
      <s-link slot="breadcrumb-actions" href="/app/flags">
        Flag queue
      </s-link>
      <s-button slot="secondary-actions" href={adminProductUrl(product.productId)} target="_blank">
        Open in Shopify
      </s-button>

      <s-section heading="The math, using today's data and settings">
        {live.status === "incomplete" ? (
          <s-banner tone="warning" heading="Can't work out the margin yet">
            <s-paragraph>
              Missing: {live.missing.map((m) => MISSING_LABELS[m] ?? m).join(", ")}. Fill these in on the product in
              Shopify and the next scan will pick it up.
            </s-paragraph>
          </s-banner>
        ) : (
          <s-stack direction="inline" gap="small-200">
            <s-badge tone={live.severity === "critical" ? "critical" : live.severity === "flagged" ? "warning" : "success"}>
              {live.severity === "critical" ? "Critical" : live.severity === "flagged" ? "Flagged" : "OK"}
            </s-badge>
            <s-text>Suggested fix: {live.fix}. Nothing is changed in Shopify; this is a suggestion only.</s-text>
          </s-stack>
        )}
        <s-box paddingBlockStart="base">
          <Receipt lines={live.lines} warnings={live.warnings} />
        </s-box>
        <s-box paddingBlockStart="base">
          <s-text color="subdued">Worked out with settings version {settingsVersionId}.</s-text>
        </s-box>
      </s-section>

      {lastFlag ? (
        <s-section heading={`As flagged by the scan on ${formatDateTime(lastFlag.finishedAt)}`}>
          <s-paragraph>
            This is the math exactly as the scan saw it (settings version {lastFlag.settingsVersionId}). It can differ from
            the card above if the product or settings changed since.
          </s-paragraph>
          <Receipt lines={lastFlag.lines} />
        </s-section>
      ) : null}

      <s-section heading="Log history">
        {history.length === 0 ? (
          <s-paragraph>No log entries for this product yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>When</s-table-header>
              <s-table-header>Who</s-table-header>
              <s-table-header>What</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {history.map((h) => (
                <s-table-row key={h.id}>
                  <s-table-cell>{formatDateTime(h.at)}</s-table-cell>
                  <s-table-cell>{h.actorName}</s-table-cell>
                  <s-table-cell>{h.event}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Inputs from Shopify" slot="aside">
        {product.imageUrl ? <s-image src={product.imageUrl} alt={name} aspectRatio="1/1" objectFit="contain" /> : null}
        <s-stack gap="small-200">
          {product.sku ? <s-text>SKU: {product.sku}</s-text> : null}
          {Object.entries(product.rawMetafields).map(([k, v]) => (
            <s-text key={k}>
              {k}: {v ?? "not set"}
            </s-text>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
