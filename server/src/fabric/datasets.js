// The Fabric Data datasets: the ONLY place a Fabric collection is named. Two datasets, a constant allow-list:
//   sales     → FactSales
//   inventory → FactInventory
// No other collection (user directories or anything added upstream later) is ever named, listed, counted, queried or returned, and
// nothing in src/fabric lists collections. Each dataset declares its ordered field allow-list (the verified schema), the fields
// that need the sensitive permission, its date (window) and company fields, search fields, allow-listed equality filters,
// index-backed sorts (key lists ending in _id), default columns, the display record key and the recommended index per sort.
// Kept free of other requires except ./fields (worker threads stay light).
const { FIELD_NAMES: SALES_FIELDS, RESTRICTED_FIELDS: SALES_RESTRICTED } = require("./fields");

// FactInventory: the 87 names after _id, in the source's own order (Fabric-Data-Plan/phase2b, discovery run 4).
const INVENTORY_FIELDS = Object.freeze([
  "Entry_No", "Posting_Date", "Entry_Type", "Document_Type", "Document_No", "External_Document_No", "Document_Line_No", "Item_No",
  "Item_Description", "Variant_Code", "Description", "Transfer_Type", "Customer_Code", "Return_Reason_Code", "Global_Dimension_1_Code",
  "Global_Dimension_2_Code", "Expiration_Date", "Serial_No", "Lot_No", "Package_No", "Location_Code", "Quantity", "RunningBalance",
  "RunningBalanceLoc", "Invoiced_Quantity", "Remaining_Quantity", "Remaining_Qty_by_Date", "Shipped_Qty_Not_Returned", "Reserved_Quantity",
  "Qty_per_Unit_of_Measure", "Unit_of_Measure_Code", "Sales_Amount_Expected", "Sales_Amount_Actual", "Cost_Amount_Expected",
  "Cost_Amount_Actual", "Cost_Amount_Non_Invtbl", "Cost_Amount_Expected_ACY", "Cost_Amount_Actual_ACY", "Cost_Amount_Non_Invtbl_ACY",
  "Completely_Invoiced", "Open", "Drop_Shipment", "Assemble_to_Order", "Applied_Entry_to_Adjust", "Order_Type", "Order_No", "Order_Line_No",
  "Prod_Order_Comp_Line_No", "Job_No", "Job_Task_No", "Dimension_Set_ID", "Shortcut_Dimension_3_Code", "Shortcut_Dimension_4_Code",
  "Shortcut_Dimension_5_Code", "Shortcut_Dimension_6_Code", "Shortcut_Dimension_7_Code", "Shortcut_Dimension_8_Code", "Source_Type",
  "Source_No", "Source_Description", "Source_Order_No", "Date_Filter", "ETag", "Company", "join_key_bc_company_item_uom", "uom_base",
  "warehouse_company", "warehouse_code", "warehouse_name", "warehouse_address", "warehouse_post_code", "warehouse_city",
  "warehouse_country_region_code", "join_key_warehouse_company_code", "pulse_id_product_db", "item_name", "uom", "landed_cost",
  "distributors_price", "trade_price", "category_1", "category_2", "category_3", "subcategory", "new_main_product_database_v2",
  "pulse_id_new_main_product_db", "date_today"
]);
if (INVENTORY_FIELDS.length !== 87 || new Set(INVENTORY_FIELDS).size !== 87) throw new Error("fabric/datasets: the verified inventory field list must have 87 distinct names.");

// Main BSON type per field (schema only; values are always typed from what the document holds). Unlisted fields are "string".
const SALES_TYPES = Object.freeze({
  invoice_due_date: "date", invoice_date: "date", invoice_date_month_start: "date", is_invoice_cancelled: "bool", is_invoice_closed: "bool",
  Line_No: "number", Quantity: "number", invoice_item_quantity: "number", invoice_item_amount: "number", invoice_total_amount: "number",
  uom_qty: "number", invoice_item_quantity_uom_item_base: "number",
  invoice_item_quantity_sales: "decimal", invoice_item_amount_sales: "decimal", Unit_Price: "decimal"
});
const INVENTORY_TYPES = Object.freeze({
  Entry_No: "number", Document_Line_No: "number", Order_Line_No: "number", Prod_Order_Comp_Line_No: "number", Dimension_Set_ID: "number",
  Posting_Date: "date", Expiration_Date: "date", date_today: "date",
  ...Object.fromEntries(["Quantity", "RunningBalance", "RunningBalanceLoc", "Invoiced_Quantity", "Remaining_Quantity", "Remaining_Qty_by_Date",
    "Shipped_Qty_Not_Returned", "Reserved_Quantity", "Qty_per_Unit_of_Measure", "Sales_Amount_Expected", "Sales_Amount_Actual",
    "Cost_Amount_Expected", "Cost_Amount_Actual", "Cost_Amount_Non_Invtbl", "Cost_Amount_Expected_ACY", "Cost_Amount_Actual_ACY",
    "Cost_Amount_Non_Invtbl_ACY"].map((f) => [f, "decimal"])),
  ...Object.fromEntries(["Completely_Invoiced", "Open", "Drop_Shipment", "Assemble_to_Order", "Applied_Entry_to_Adjust"].map((f) => [f, "bool"]))
});

const freezeDeep = (value) => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freezeDeep); } return value; };

const DATASETS = freezeDeep(Object.assign(Object.create(null), {
  sales: {
    name: "sales", label: "Sales", collection: "FactSales",
    fields: SALES_FIELDS, types: SALES_TYPES,
    // landed_cost, plus Text, Custom, custom_1 and Custom.2 until their business meaning is confirmed (fields.js).
    sensitive: [...SALES_RESTRICTED],
    dateField: "invoice_date", companyField: "Company",
    // kind: "prefix" (case-sensitive, anchored) or "contains" (case-insensitive substring)
    searchFields: [["invoice_id", "prefix"], ["customer_id", "prefix"], ["customer_name", "contains"], ["invoice_item_id", "prefix"], ["invoice_item_name", "contains"], ["external_document_no", "contains"]],
    filters: { company: { field: "Company", type: "company" }, salesDataSource: { field: "sales_data_source", type: "string" }, salesType: { field: "sales_type", type: "string" }, customerId: { field: "customer_id", type: "string" }, invoiceNo: { field: "invoice_id", type: "string" } },
    // keys: the index key pattern (dir=desc on the lead field walks the index forwards when the lead is -1).
    sorts: { date: { lead: "invoice_date", keys: [["invoice_date", -1], ["Company", 1], ["invoice_id", 1], ["_id", 1]] } },
    defaultSort: "date",
    defaultColumns: ["invoice_date", "Company", "invoice_id", "customer_name", "invoice_item_name", "invoice_item_quantity", "invoice_item_amount", "sales_data_source"],
    recordKey: ["Company", "invoice_id", "Line_No"],
    indexes: { date: { name: "fabric_invoice_date", keys: { invoice_date: -1, Company: 1, invoice_id: 1, _id: 1 } } },
    maxDays: 92, windowOptionalWhenSmall: false, blankDateFields: [],
    // Advanced filters (filter-model.js; audits 02 §4 and 03): category = few distinct values (kind "category", value list
    // "distinct"); valueSearch = a searchable value list; disabled = constant, always empty or always null (no operators).
    filtering: {
      categories: ["Company", "sales_data_source", "sales_type", "classification", "category", "type", "level", "subcategory", "category_1", "category_2", "category_3",
        "business_unit_2026", "Location_Code", "uom_code", "uom", "warehouse", "region", "Data_Table", "Salesperson_Code", "invoice_terms_description",
        "is_tagged_product_db", "is_tagged_main_product_db", "is_tagged_customer_db", "is_tagged_territory_db"],
      valueSearch: ["customer_id", "customer_name", "invoice_item_id", "invoice_item_name", "Ship_to_Name", "Order_No", "external_document_no"],
      disabled: ["sales_data_type", "invoice_status"]
    }
  },
  inventory: {
    name: "inventory", label: "Inventory", collection: "FactInventory",
    fields: INVENTORY_FIELDS, types: INVENTORY_TYPES,
    sensitive: ["Cost_Amount_Expected", "Cost_Amount_Actual", "Cost_Amount_Non_Invtbl", "Cost_Amount_Expected_ACY", "Cost_Amount_Actual_ACY", "Cost_Amount_Non_Invtbl_ACY", "landed_cost", "distributors_price", "trade_price"],
    dateField: "Posting_Date", companyField: "Company",
    searchFields: [["Item_No", "prefix"], ["Item_Description", "contains"], ["item_name", "contains"], ["Document_No", "prefix"], ["Lot_No", "prefix"], ["Serial_No", "prefix"]],
    filters: { company: { field: "Company", type: "company" }, entryType: { field: "Entry_Type", type: "string" }, documentType: { field: "Document_Type", type: "string" }, locationCode: { field: "Location_Code", type: "string" }, itemNo: { field: "Item_No", type: "string" }, open: { field: "Open", type: "bool" } },
    sorts: {
      date: { lead: "Posting_Date", keys: [["Posting_Date", -1], ["Company", 1], ["Entry_No", 1], ["_id", 1]] },
      // Not led by the date: one company (required, it bounds the index walk), no date window (refused), in every mode.
      entryNo: { lead: "Entry_No", keys: [["Company", 1], ["Entry_No", 1], ["_id", 1]], requiresCompany: true, noDateWindow: true }
    },
    defaultSort: "date",
    defaultColumns: ["Posting_Date", "Company", "Entry_No", "Entry_Type", "Document_No", "Item_No", "Item_Description", "Location_Code", "Quantity", "Remaining_Quantity", "Unit_of_Measure_Code"],
    recordKey: ["Company", "Entry_No"],
    indexes: {
      date: { name: "fabric_inventory_date", keys: { Posting_Date: -1, Company: 1, Entry_No: 1, _id: 1 } },
      entryNo: { name: "fabric_inventory_entry", keys: { Company: 1, Entry_No: 1, _id: 1 } }
    },
    // Small-collection mode may browse the whole collection (no date window); indexed mode follows the 92-day rule.
    maxDays: 92, windowOptionalWhenSmall: true,
    // Business Central writes 0001-01-01 for "no date": returned as null (years before 1900).
    blankDateFields: ["Expiration_Date"],
    filtering: {
      categories: ["Company", "Entry_Type", "Document_Type", "Order_Type", "Source_Type", "Unit_of_Measure_Code", "uom", "uom_base", "Global_Dimension_1_Code",
        "Global_Dimension_2_Code", "category_1", "category_2", "category_3", "subcategory", "Location_Code", "warehouse_code", "warehouse_name"],
      valueSearch: ["Item_No", "item_name", "Item_Description", "Document_No", "Lot_No", "Serial_No", "Source_No"],
      // Constant or always empty (the legacy open= parameter stays for compatibility), and the always-zero decimals.
      disabled: ["Variant_Code", "Customer_Code", "Return_Reason_Code", "Package_No", "Job_No", "Job_Task_No", "Shortcut_Dimension_3_Code", "Shortcut_Dimension_6_Code",
        "Date_Filter", "Transfer_Type", "ETag", "Prod_Order_Comp_Line_No", "Open", "Drop_Shipment", "Assemble_to_Order",
        "RunningBalance", "RunningBalanceLoc", "Shipped_Qty_Not_Returned", "Reserved_Quantity", "Sales_Amount_Expected"]
    }
  }
}));

const DATASET_NAMES = Object.freeze(Object.keys(DATASETS));
const COLLECTIONS = Object.freeze(DATASET_NAMES.map((n) => DATASETS[n].collection));

// The dataset for a URL segment, or null. Exact names only ("Sales" or a collection name is not a dataset).
const datasetNamed = (name) => (typeof name === "string" && Object.hasOwn(DATASETS, name) ? DATASETS[name] : null);
// The fields a caller may see, in the verified order.
const permittedFields = (ds, sensitive) => ds.fields.filter((f) => sensitive || !ds.sensitive.includes(f));
const typeOfField = (ds, field) => ds.types[field] || "string";

// Self-check at load: nothing sensitive is filterable, sortable, searchable, a default column or part of the record key, and
// every name refers to an allow-listed field.
for (const ds of Object.values(DATASETS)) {
  const all = new Set([...ds.fields, "_id"]);
  const used = [ds.dateField, ds.companyField, ...ds.searchFields.map(([f]) => f), ...Object.values(ds.filters).map((f) => f.field),
    ...Object.values(ds.sorts).flatMap((s) => s.keys.map(([f]) => f)), ...ds.defaultColumns, ...ds.recordKey];
  for (const f of used) {
    if (!all.has(f)) throw new Error(`fabric/datasets: ${ds.name} names an unknown field.`);
    if (ds.sensitive.includes(f)) throw new Error(`fabric/datasets: ${ds.name} uses a sensitive field outside the projection.`);
    if (f.includes(".")) throw new Error(`fabric/datasets: ${ds.name} filters, sorts or searches a dotted field.`);
  }
  for (const f of ds.sensitive) if (!ds.fields.includes(f)) throw new Error(`fabric/datasets: ${ds.name} sensitive field is not in its allow-list.`);
  // Advanced filters: the category and value-search lists name only allow-listed, non-sensitive, undotted string fields.
  for (const f of [...ds.filtering.categories, ...ds.filtering.valueSearch]) {
    if (!ds.fields.includes(f) || ds.sensitive.includes(f) || f.includes(".") || (ds.types[f] || "string") !== "string") throw new Error(`fabric/datasets: ${ds.name} filtering lists a field that can't have a value list.`);
  }
  for (const f of ds.filtering.disabled) if (!ds.fields.includes(f)) throw new Error(`fabric/datasets: ${ds.name} disables an unknown field.`);
  for (const [name, sort] of Object.entries(ds.sorts)) {
    if (sort.keys.at(-1)[0] !== "_id") throw new Error(`fabric/datasets: ${ds.name} sort ${name} must end in _id.`);
    if (JSON.stringify(Object.fromEntries(sort.keys)) !== JSON.stringify(ds.indexes[name]?.keys)) throw new Error(`fabric/datasets: ${ds.name} sort ${name} needs its recommended index.`);
  }
}

module.exports = { DATASETS, DATASET_NAMES, COLLECTIONS, datasetNamed, permittedFields, typeOfField, INVENTORY_FIELDS };
