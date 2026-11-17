/**
 * Admin GraphQL documents used by the scan. All of them are read only.
 */

/** Metafields the scan reads, as [alias, namespace, key]. */
export const METAFIELDS = [
  ["boxLength", "freight", "box_length"],
  ["boxWidth", "freight", "box_width"],
  ["boxHeight", "freight", "box_height"],
  ["boxCount", "freight", "box_count"],
  ["overrideCost", "freight", "override_cost"],
  ["map", "pricing", "map"],
] as const;

const metafieldFields = METAFIELDS.map(
  ([alias, ns, key]) => `${alias}: metafield(namespace: "${ns}", key: "${key}") { value }`,
).join("\n          ");

/**
 * The bulk query. It walks variants directly (not products → variants) so each
 * JSONL line is one self-contained variant. That lets the result be processed
 * in chunks, in any order, and resumed by line number.
 */
export const VARIANT_BULK_QUERY = `{
  productVariants(query: "product_status:active") {
    edges {
      node {
        id
        title
        sku
        price
        compareAtPrice
        product {
          id
          title
          status
          featuredMedia { preview { image { url } } }
        }
        inventoryItem {
          requiresShipping
          unitCost { amount }
          measurement { weight { value unit } }
        }
          ${metafieldFields}
      }
    }
  }
}`;

export const BULK_RUN_MUTATION = `#graphql
  mutation RunVariantScan($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;

export const BULK_STATUS_QUERY = `#graphql
  query ScanBulkStatus($id: ID!) {
    bulkOperation(id: $id) {
      id
      status
      errorCode
      objectCount
      url
      partialDataUrl
    }
  }`;

export const ACTIVE_PRODUCTS_COUNT_QUERY = `#graphql
  query ActiveProductsCount {
    productsCount(query: "status:active", limit: null) { count }
  }`;

export const METAFIELD_DEFINITIONS_QUERY = `#graphql
  query FreightMetafieldDefinitions {
    freight: metafieldDefinitions(first: 50, ownerType: PRODUCTVARIANT, namespace: "freight") {
      nodes { namespace key name type { name } }
    }
    pricing: metafieldDefinitions(first: 50, ownerType: PRODUCTVARIANT, namespace: "pricing") {
      nodes { namespace key name type { name } }
    }
  }`;

export const UNITS_SOLD_QUERY = `#graphql
  query UnitsSold30d($q: String!) {
    shopifyqlQuery(query: $q) {
      tableData { columns { name dataType } rows }
      parseErrors
    }
  }`;

export const UNITS_SOLD_SHOPIFYQL =
  "FROM sales SHOW net_items_sold GROUP BY product_variant_id DURING last_30_days LIMIT 10000";

/** One variant, same fields as the bulk query. Used by the product detail screen. */
export const VARIANT_DETAIL_QUERY = `#graphql
  query VariantDetail($id: ID!) {
    productVariant(id: $id) {
      id
      title
      sku
      price
      compareAtPrice
      product {
        id
        title
        status
        featuredMedia { preview { image { url } } }
      }
      inventoryItem {
        requiresShipping
        unitCost { amount }
        measurement { weight { value unit } }
      }
      ${metafieldFields}
    }
  }`;
