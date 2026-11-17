import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { requireStaff } from "../lib/staff.server";
import { latestFinishedScan } from "../lib/data.server";
import type { DataHealthSummary } from "../lib/scan/scan.server";
import { METAFIELDS } from "../lib/scan/queries";
import { adminProductUrl, formatDateTime, MISSING_LABELS } from "../lib/format";
import { gidToId } from "../lib/scan/variant-line";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireStaff(request);
  const scan = await latestFinishedScan(shop);
  if (!scan) return { scan: null, health: null, issues: [] };
  const issues = await prisma.dataIssue.findMany({
    where: { scanId: scan.id },
    orderBy: [{ productTitle: "asc" }],
    take: 2000,
  });
  return {
    scan: { id: scan.id, finishedAt: scan.finishedAt?.toISOString() ?? null, variants: scan.variantsScanned },
    health: scan.dataHealth as unknown as DataHealthSummary | null,
    issues: issues.map((i) => ({
      id: i.id,
      productId: i.productId,
      variantId: i.variantId,
      title: i.variantTitle ? `${i.productTitle} – ${i.variantTitle}` : i.productTitle,
      missing: i.missing,
      hasMap: i.hasMap,
    })),
  };
};

export default function DataHealth() {
  const { scan, health, issues } = useLoaderData<typeof loader>();
  if (!scan) {
    return (
      <s-page heading="Data health">
        <s-section>
          <s-paragraph>No scan has finished yet.</s-paragraph>
        </s-section>
      </s-page>
    );
  }
  const c = health?.counts;
  return (
    <s-page heading="Data health" inlineSize="large">
      <s-section heading="Metafield setup">
        {health?.definitionsError ? (
          <s-banner tone="warning" heading="Couldn't read metafield definitions">
            <s-paragraph>{health.definitionsError}</s-paragraph>
          </s-banner>
        ) : health && health.missingDefinitions.length ? (
          <s-banner tone="warning" heading="Some metafields the app reads don't have definitions yet">
            <s-paragraph>
              Create these variant metafield definitions in Shopify (Settings → Custom data → Variants). This app doesn’t
              create them in Phase 1.
            </s-paragraph>
            <s-unordered-list>
              {health.missingDefinitions.map((k) => (
                <s-list-item key={k}>{k}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        ) : (
          <s-paragraph>All {METAFIELDS.length} metafield definitions exist.</s-paragraph>
        )}
        {health?.definitions.length ? (
          <s-paragraph>
            Found: {health.definitions.map((d) => `${d.key} (${d.type})`).join(", ")}.
          </s-paragraph>
        ) : null}
      </s-section>

      <s-section heading={`Gaps in the scan finished ${formatDateTime(scan.finishedAt)}`}>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <Count label="Missing unit cost" n={c?.missingCost ?? 0} />
          <Count label="Missing box dimensions" n={c?.missingDimensions ?? 0} />
          <Count label="Missing price" n={c?.missingPrice ?? 0} />
          <Count label="No MAP set" n={c?.missingMap ?? 0} />
        </s-grid>
        <s-paragraph>
          Out of {scan.variants} variants that ship. Variants missing cost, dimensions or price can’t be checked and are
          not in the flag queue. A missing MAP doesn’t stop the check; the suggested price just ignores MAP.
        </s-paragraph>
      </s-section>

      <s-section heading="Variants with gaps" padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header>Product</s-table-header>
            <s-table-header>Can’t be checked because of</s-table-header>
            <s-table-header>MAP</s-table-header>
            <s-table-header>Shopify</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {issues.map((i) => (
              <s-table-row key={i.id}>
                <s-table-cell>
                  <s-link href={`/app/products/${gidToId(i.variantId)}`}>{i.title}</s-link>
                </s-table-cell>
                <s-table-cell>
                  {i.missing.length ? i.missing.map((m) => MISSING_LABELS[m] ?? m).join(", ") : "Nothing (checked)"}
                </s-table-cell>
                <s-table-cell>{i.hasMap ? "Set" : "Not set"}</s-table-cell>
                <s-table-cell>
                  <s-link href={adminProductUrl(i.productId)} target="_blank">
                    Edit
                  </s-link>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {issues.length >= 2000 ? (
          <s-box padding="base">
            <s-text color="subdued">Showing the first 2,000.</s-text>
          </s-box>
        ) : null}
      </s-section>
    </s-page>
  );
}

function Count({ label, n }: { label: string; n: number }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{n.toLocaleString("en-US")}</s-heading>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
