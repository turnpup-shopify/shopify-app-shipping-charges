import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { requireStaff } from "../lib/staff.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { staff } = await requireStaff(request);
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", role: staff.role };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/flags">Flag queue</s-link>
        <s-link href="/app/activity">Activity log</s-link>
        <s-link href="/app/data-health">Data health</s-link>
        <s-link href="/app/price-list">Uttermost price list</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
