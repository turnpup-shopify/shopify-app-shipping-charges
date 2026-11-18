import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import type { Prisma } from "@prisma/client";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { isAdmin, requireStaff } from "../lib/staff.server";
import { formatDateTime, formatMoney } from "../lib/format";
import { checkPriceList, priceListUrl, savePriceListUrl } from "../lib/price-list/price-list.server";
import { KEEP_VERSIONS, PriceListUrlError } from "../lib/price-list/source";

const PAGE_SIZE = 100;
const SHIPPING_CLASSES = ["Small Parcel", "Oversize", "Motor Freight"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, staff } = await requireStaff(request);
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim();
  const shippingClass = params.get("class") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);

  const [source, url, versions] = await Promise.all([
    prisma.priceListSource.findUnique({ where: { shop } }),
    priceListUrl(shop),
    prisma.priceListImport.findMany({
      where: { shop },
      orderBy: { importedAt: "desc" },
      take: KEEP_VERSIONS,
      select: {
        id: true,
        fileName: true,
        rowCount: true,
        importedAt: true,
        trigger: true,
        triggeredByName: true,
        byteSize: true,
      },
    }),
  ]);
  const latest = versions[0] ?? null;

  let items: Array<{
    id: number;
    itemNumber: string;
    productName: string | null;
    collection: string | null;
    category: string | null;
    wholesaleCents: number | null;
    totalPriceCents: number | null;
    mapCents: number | null;
    shippingClass: string | null;
    shipMethod: string | null;
    boxSize: string | null;
    shippingWeight: string | null;
  }> = [];
  let total = 0;
  if (latest) {
    const where: Prisma.PriceListItemWhereInput = {
      importId: latest.id,
      ...(shippingClass ? { shippingClass } : {}),
      ...(q
        ? {
            OR: [
              { itemNumber: { contains: q, mode: "insensitive" } },
              { productName: { contains: q, mode: "insensitive" } },
              { collection: { contains: q, mode: "insensitive" } },
              { upc: { contains: q } },
            ],
          }
        : {}),
    };
    const [rows, count] = await Promise.all([
      prisma.priceListItem.findMany({
        where,
        orderBy: { itemNumber: "asc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          itemNumber: true,
          productName: true,
          collection: true,
          category: true,
          wholesaleCents: true,
          totalPriceCents: true,
          mapCents: true,
          shippingClass: true,
          shipMethod: true,
          boxSize: true,
          shippingWeight: true,
        },
      }),
      prisma.priceListItem.count({ where }),
    ]);
    items = rows.map((r) => ({ ...r, shippingWeight: r.shippingWeight?.toString() ?? null }));
    total = count;
  }

  return {
    canEdit: isAdmin(staff),
    url,
    lastCheck: source?.lastCheckedAt
      ? {
          at: source.lastCheckedAt.toISOString(),
          status: source.lastCheckStatus,
          detail: source.lastCheckDetail,
        }
      : null,
    versions: versions.map((v) => ({ ...v, importedAt: v.importedAt.toISOString() })),
    latestId: latest?.id ?? null,
    filter: { q, class: shippingClass },
    items,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, staff, actor } = await requireStaff(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "check") {
    const result = await checkPriceList(shop, "MANUAL", actor);
    switch (result.status) {
      case "imported":
        return { ok: true as const, message: `Imported a new version: ${result.rowCount.toLocaleString("en-US")} items.` };
      case "unchanged":
        return { ok: true as const, message: "No new version. The file hasn't changed since the last import." };
      default:
        return { ok: false as const, message: result.error };
    }
  }

  if (intent === "save-url") {
    if (!isAdmin(staff)) return { ok: false as const, message: "Only Admins can change the link." };
    try {
      await savePriceListUrl(shop, actor, String(form.get("url") ?? ""));
      return { ok: true as const, message: "Link saved. Click “Check for new version” to import from it." };
    } catch (e) {
      if (e instanceof PriceListUrlError) return { ok: false as const, message: e.message };
      throw e;
    }
  }

  return { ok: false as const, message: "Unknown action." };
};

const money = (cents: number | null) => (cents == null ? "" : formatMoney(cents));

export default function PriceList() {
  const data = useLoaderData<typeof loader>();
  const { canEdit, versions, latestId, items, total, page, pages, lastCheck } = data;
  const check = useFetcher<typeof action>();
  const save = useFetcher<typeof action>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [f, setF] = useState(data.filter);
  const [url, setUrl] = useState(data.url);
  const checking = check.state !== "idle";

  useEffect(() => {
    if (check.data) shopify.toast.show(check.data.message, { isError: !check.data.ok });
  }, [check.data, shopify]);
  useEffect(() => {
    if (save.data) shopify.toast.show(save.data.message, { isError: !save.data.ok });
  }, [save.data, shopify]);

  const go = (next: { q: string; class: string }, p = 1) => {
    setF(next);
    const sp = new URLSearchParams();
    if (next.q) sp.set("q", next.q);
    if (next.class) sp.set("class", next.class);
    if (p > 1) sp.set("page", String(p));
    navigate(`/app/price-list?${sp.toString()}`);
  };
  const val = (e: Event) => (e.currentTarget as HTMLInputElement).value;
  const latest = versions[0];

  return (
    <s-page heading="Uttermost price list" inlineSize="large">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => check.submit({ intent: "check" }, { method: "POST" })}
        {...(checking ? { loading: true } : {})}
      >
        Check for new version
      </s-button>

      {lastCheck?.status === "failed" ? (
        <s-banner tone="critical" heading="The last check failed">
          <s-paragraph>
            {formatDateTime(lastCheck.at)}: {lastCheck.detail}
          </s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Current version">
        {latest ? (
          <s-stack gap="small-200">
            <s-paragraph>
              <s-text type="strong">{latest.fileName}</s-text>, version {latest.id}:{" "}
              {latest.rowCount.toLocaleString("en-US")} items, imported {formatDateTime(latest.importedAt)} by{" "}
              {latest.triggeredByName}.
            </s-paragraph>
            {lastCheck ? (
              <s-text color="subdued">
                Last checked {formatDateTime(lastCheck.at)}. {lastCheck.detail}
              </s-text>
            ) : null}
            <s-text color="subdued">
              The app checks Dropbox every morning and imports the file only when its contents change. It stores the
              data in this app only; it never changes anything in Shopify.
            </s-text>
          </s-stack>
        ) : (
          <s-paragraph>Nothing imported yet. Click “Check for new version” to download the price list.</s-paragraph>
        )}
      </s-section>

      {latestId ? (
        <s-section heading="Items" padding="none">
          <s-box padding="base">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
              <s-search-field
                label="Search"
                placeholder="Item number, name, collection or UPC"
                value={f.q}
                onChange={(e) => go({ ...f, q: val(e) })}
              />
              <s-select label="Shipping class" value={f.class} onChange={(e) => go({ ...f, class: val(e) })}>
                <s-option value="">All</s-option>
                {SHIPPING_CLASSES.map((c) => (
                  <s-option key={c} value={c}>
                    {c}
                  </s-option>
                ))}
              </s-select>
            </s-grid>
          </s-box>
          <s-table
            paginate
            hasPreviousPage={page > 1}
            hasNextPage={page < pages}
            onPreviousPage={() => go(f, page - 1)}
            onNextPage={() => go(f, page + 1)}
          >
            <s-table-header-row>
              <s-table-header>Item number</s-table-header>
              <s-table-header>Product</s-table-header>
              <s-table-header>Category</s-table-header>
              <s-table-header format="numeric">Wholesale</s-table-header>
              <s-table-header format="numeric">Total Utt. price</s-table-header>
              <s-table-header format="numeric">MAP</s-table-header>
              <s-table-header>Shipping class</s-table-header>
              <s-table-header>Ship method</s-table-header>
              <s-table-header>Box size</s-table-header>
              <s-table-header format="numeric">Ship weight</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {items.map((i) => (
                <s-table-row key={i.id}>
                  <s-table-cell>{i.itemNumber}</s-table-cell>
                  <s-table-cell>{i.productName ?? ""}</s-table-cell>
                  <s-table-cell>{i.category ?? ""}</s-table-cell>
                  <s-table-cell>{money(i.wholesaleCents)}</s-table-cell>
                  <s-table-cell>{money(i.totalPriceCents)}</s-table-cell>
                  <s-table-cell>{money(i.mapCents)}</s-table-cell>
                  <s-table-cell>{i.shippingClass ?? ""}</s-table-cell>
                  <s-table-cell>{i.shipMethod ?? ""}</s-table-cell>
                  <s-table-cell>{i.boxSize ?? ""}</s-table-cell>
                  <s-table-cell>{i.shippingWeight ?? ""}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          <s-box padding="base">
            <s-text color="subdued">
              {total.toLocaleString("en-US")} items. Page {page} of {pages}.
            </s-text>
          </s-box>
        </s-section>
      ) : null}

      {versions.length ? (
        <s-section heading="Versions" padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header>Version</s-table-header>
              <s-table-header>Imported (Central)</s-table-header>
              <s-table-header>By</s-table-header>
              <s-table-header format="numeric">Items</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {versions.map((v) => (
                <s-table-row key={v.id}>
                  <s-table-cell>
                    {v.id}
                    {v.id === latestId ? " (current)" : ""}
                  </s-table-cell>
                  <s-table-cell>{formatDateTime(v.importedAt)}</s-table-cell>
                  <s-table-cell>
                    {v.triggeredByName}
                    {v.trigger === "CRON" ? " (daily check)" : ""}
                  </s-table-cell>
                  <s-table-cell>{v.rowCount.toLocaleString("en-US")}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          <s-box padding="base">
            <s-text color="subdued">The last {KEEP_VERSIONS} versions are kept.</s-text>
          </s-box>
        </s-section>
      ) : null}

      <s-section heading="Dropbox link">
        <s-stack gap="base">
          <s-paragraph>
            The link to the price list file itself, not the folder. When Uttermost sends a new folder, open it in
            Dropbox, click the price list file, copy its link and paste it here.
          </s-paragraph>
          <s-text-field
            label="Link to the .xlsx file"
            value={url}
            onInput={(e) => setUrl(val(e))}
            {...(!canEdit ? { readOnly: true, details: "Only Admins can change the link." } : {})}
          />
          {canEdit ? (
            <s-button
              onClick={() => save.submit({ intent: "save-url", url }, { method: "POST" })}
              {...(save.state !== "idle" ? { loading: true } : {})}
              {...(url === data.url ? { disabled: true } : {})}
            >
              Save link
            </s-button>
          ) : null}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
