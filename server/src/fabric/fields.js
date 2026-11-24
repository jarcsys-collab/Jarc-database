// The FactSales fields Fabric Data may return (verified schema, Fabric-Data-Plan/phase2): the 85 names after _id, in the
// source's own order. Anything else upstream adds later is never projected or returned. Kept free of other requires.
const COLLECTION = "FactSales";

const FIELD_NAMES = Object.freeze([
  "invoice_id", "customer_name", "invoice_due_date", "Order_No", "external_document_no", "Salesperson_Code", "is_invoice_cancelled",
  "is_invoice_closed", "invoice_terms_description", "Location_Code", "Ship_to_Code", "Ship_to_Name", "Ship_to_City", "Company", "Line_No",
  "customer_id", "invoice_item_id", "invoice_item_name", "Description_2", "invoice_item_quantity_sales", "uom_code", "uom_displayName",
  "invoice_item_amount_sales", "Unit_Price", "invoice_total_amount", "sales_data_source", "finalCustID",
  "pulse_id_territory_database_2025_w_whitelisted", "pulse_id_territory_database", "pulse_id_customer_db", "No", "Quantity", "Data_Table",
  "category", "classification", "type", "level", "pulse_id_territory_db_with_distributors", "pulse_id_product_db", "uom", "category_1",
  "category_2", "category_3", "subcategory", "landed_cost", "new_main_product_database_v2", "business_unit_2026",
  "pulse_id_new_main_product_db", "pulse_id_main_product_db", "main_product", "product_grouping", "join_key_bc_company_item_uom",
  "invoice_item_quantity", "invoice_item_amount", "uom_qty", "uom_base", "invoice_item_quantity_uom_item_base",
  "join_key_bc_valueEntries_Sales_Invoice", "invoice_date", "warehouse", "invoice_status", "territory_sales", "item_name",
  "sales_data_type", "is_tagged_product_db", "is_tagged_main_product_db", "is_tagged_customer_db", "is_tagged_territory_db",
  "invoice_date_month_start", "sales_type", "pulse_id_whitelisted_account", "territory_whitelisted_config", "region",
  "join_key_Invoice_CustLedger", "join_key_Company_Invoice", "join_key_company_salesperson_code", "Text", "Custom", "territorytest_try",
  "custom_1", "pulse_id_territory_with_distributors_try", "connect_to_rmr", "connect_to_salescreditmemo", "Custom.2", "Ref"
]);
if (FIELD_NAMES.length !== 85 || new Set(FIELD_NAMES).size !== 85) throw new Error("fabric/fields: the verified field list must have 85 distinct names.");

// Sensitive: only ever projected for cost readers.
const COST_FIELD = "landed_cost";
// Has a dot in its name: read only with $getField, never filtered, sorted or indexed on.
const DOTTED_FIELD = "Custom.2";
// FactSales fields only sensitive readers get: the cost field, and (approved 2026-11-24) the custom columns whose business
// meaning isn't confirmed yet. Used by the dataset explorer (datasets.js) and the invoice views alike.
const RESTRICTED_FIELDS = Object.freeze([COST_FIELD, "Text", "Custom", "custom_1", DOTTED_FIELD]);
const isRestricted = (name) => RESTRICTED_FIELDS.includes(name);
const KEY_FIELDS = Object.freeze(["join_key_Company_Invoice", "join_key_Invoice_CustLedger", "join_key_bc_company_item_uom", "join_key_bc_valueEntries_Sales_Invoice", "join_key_company_salesperson_code", "connect_to_rmr", "connect_to_salescreditmemo", "Ref"]);
// The invoice header (first non-null value over the invoice's rows); territory is Custom.2.
const HEADER_FIELDS = Object.freeze(["Order_No", "external_document_no", "Salesperson_Code", "invoice_terms_description", "Location_Code", "Ship_to_Name", "Ship_to_City", "is_invoice_cancelled", "is_invoice_closed", "category", "classification", "business_unit_2026", "territory_sales", "region"]);
// Header fields that can differ by source: distinct values.
const HEADER_SETS = Object.freeze(["sales_data_source", "sales_type"]);

for (const f of RESTRICTED_FIELDS) if (!FIELD_NAMES.includes(f)) throw new Error("fabric/fields: a restricted field isn't a verified field.");

module.exports = { COLLECTION, FIELD_NAMES, COST_FIELD, DOTTED_FIELD, RESTRICTED_FIELDS, isRestricted, KEY_FIELDS, HEADER_FIELDS, HEADER_SETS };
