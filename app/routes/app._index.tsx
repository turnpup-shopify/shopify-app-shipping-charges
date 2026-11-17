import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { waitUntil } from "@vercel/functions";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { requireStaff } from "../lib/staff.server";
import { latestFinishedScan, latestScan } from "../lib/data.server";
import {
  processScan,
  reconcileRunningScan,
  ScanAlreadyRunningError,
  startScan,
} from "../lib/scan/scan.server";
import { Explain } from "../components/Explain";
import { formatDateTime, formatMoney } from "../lib/format";

export const config = { maxDuration: 300 };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireStaff(request);

  // If a scan has been running a while, ask Shopify directly in case the
  // finish webhook was missed (common in local development).
  const current = await latestScan(shop);
  if (current?.status === "RUNNING" && Date.now() - current.startedAt.getTime() > 2 * 60_000) {
    const id = await reconcileRunningScan(current).catch(() => null);
    if (id) waitUntil(processScan(id).catch((e) => console.error(e)));
  }

  const [last, active] = await Promise.all([
    latestFinishedScan(shop),
    prisma.scan.findFirst({
      where: { shop, status: { in: ["STARTING", "RUNNING", "PROCESSING"] } },
      orderBy: { startedAt: "desc" },
    }),
  ]);
  const lastFailed = await prisma.scan.findFirst({
    where: { shop, status: "FAILED", ...(last ? { startedAt: { gt: last.startedAt } } : {}) },
    orderBy: { startedAt: "desc" },
  });

  let counts = { flagged: 0, critical: 0, lossFlags: 0 };
  if (last) {
    const [flagged, critical, lossFlags] = await Promise.all([
      prisma.flag.count({ where: { scanId: last.id, severity: "FLAGGED" } }),
      prisma.flag.count({ where: { scanId: last.id, severity: "CRITICAL" } }),
      prisma.flag.count({ where: { scanId: last.id, unitsSold30d: { gt: 0 }, severity: "CRITICAL" } }),
    ]);
    counts = { flagged, critical, lossFlags };
  }

  return {
    last: last && {
      id: last.id,
      startedAt: last.startedAt.toISOString(),
      finishedAt: last.finishedAt?.toISOString() ?? null,
      trigger: last.trigger,
      triggeredByName: last.triggeredByName,
      productsScanned: last.productsScanned,
      variantsScanned: last.variantsScanned,
      monthlyLossCents: last.monthlyLossCents,
      settingsVersionId: last.settingsVersionId,
    },
    active: active && {
      id: active.id,
      status: active.status,
      startedAt: active.startedAt.toISOString(),
      triggeredByName: active.triggeredByName,
      variantsScanned: active.variantsScanned,
    },
    lastFailed: lastFailed && { at: lastFailed.startedAt.toISOString(), error: lastFailed.error },
    counts,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, actor } = await requireStaff(request);
  try {
    const scan = await startScan(shop, "MANUAL", actor);
    return { ok: true as const, scanId: scan.id };
  } catch (e) {
    if (e instanceof ScanAlreadyRunningError) return { ok: false as const, error: "A scan is already running." };
    return { ok: false as const, error: e instanceof Error ? e.message : "Could not start the scan." };
  }
};

export default function Dashboard() {
  const { last, active, lastFailed, counts } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const starting = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) shopify.toast.show("Scan started. This page updates when it's done.");
    else shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  // While a scan runs, refresh every 10 seconds.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => revalidator.revalidate(), 10_000);
    return () => clearInterval(t);
  }, [active, revalidator]);

  const statusText: Record<string, string> = {
    STARTING: "Starting",
    RUNNING: "Shopify is gathering product data",
    PROCESSING: "Checking products",
  };

  return (
    <s-page heading="Freight Margin Guard">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => fetcher.submit({}, { method: "POST" })}
        {...(starting ? { loading: true } : {})}
        {...(active ? { disabled: true } : {})}
      >
        Run scan now
      </s-button>

      {active ? (
        <s-banner tone="info" heading="A scan is running">
          <s-paragraph>
            {statusText[active.status] ?? active.status}. Started {formatDateTime(active.startedAt)} by{" "}
            {active.triggeredByName}. {active.variantsScanned > 0 ? `${active.variantsScanned} variants checked so far.` : ""}
          </s-paragraph>
        </s-banner>
      ) : null}
      {lastFailed ? (
        <s-banner tone="critical" heading="The last scan failed">
          <s-paragraph>
            {formatDateTime(lastFailed.at)}: {lastFailed.error ?? "Unknown error"}
          </s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Latest scan">
        {!last ? (
          <s-paragraph>
            No scan has finished yet. Click Run scan now, or wait for the nightly scan at 2am Central.
          </s-paragraph>
        ) : (
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
            <Stat
              title="Critical"
              value={String(counts.critical)}
              how="Variants losing money after freight: margin after freight is under the critical threshold (0% by default). Click through to the flag queue to see them."
              href="/app/flags?severity=CRITICAL"
            />
            <Stat
              title="Flagged"
              value={String(counts.flagged)}
              how="Variants making money, but under the flag threshold (20% by default) after freight."
              href="/app/flags?severity=FLAGGED"
            />
            <Stat
              title="Estimated monthly dollars lost"
              value={last.monthlyLossCents == null ? "Not available" : formatMoney(last.monthlyLossCents)}
              how={
                last.monthlyLossCents == null
                  ? "Sales data could not be read from Shopify reports for this scan, so this can't be worked out. Check that the app has the read_reports scope."
                  : `For each critical variant: (landed cost − price) × units sold in the last 30 days, added up. ${counts.lossFlags} critical variant${counts.lossFlags === 1 ? "" : "s"} sold at least one unit. It is money lost against breaking even, not against the target margin.`
              }
            />
            <Stat
              title="Last scan"
              value={formatDateTime(last.finishedAt ?? last.startedAt)}
              how={`${last.trigger === "CRON" ? "Nightly scan" : `Run by ${last.triggeredByName}`}. Checked ${last.variantsScanned} variants across ${last.productsScanned} active products, using settings version ${last.settingsVersionId}.`}
            />
          </s-grid>
        )}
      </s-section>

      <s-section heading="How this works" slot="aside">
        <s-paragraph>
          Every night at 2am Central, the app reads every active product from Shopify, works out freight from the box
          size and weight, and flags anything whose margin after freight is too low.
        </s-paragraph>
        <s-paragraph>
          This app only reads data. It never changes prices, products, tags or shipping. Suggested fixes are
          suggestions only.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function Stat({ title, value, how, href }: { title: string; value: string; how: string; href?: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-text color="subdued">{title}</s-text>
        <s-heading>
          <Explain value={value} how={how} label={title} />
        </s-heading>
        {href ? <s-link href={href}>View in flag queue</s-link> : null}
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
