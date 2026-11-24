// Fabric Data field metadata (presentation only): friendly labels, Overview groups, value formatting and record-key flags for
// the two verified Fabric datasets (FactSales: 85 fields, FactInventory: 87 fields; server/src/fabric/fields.js and datasets.js).
// API field names are never changed: labels are shown next to them, and every request still uses the original names.
// Pure: no DOM, no requests, no storage. Which fields a person actually sees is decided by the server (restricted fields are left
// out of the response); a group here only lists names, it never makes a value appear.
class FabricFieldMeta {
  // Overview groups per dataset: [id, title, fields]. Every verified field is in exactly one group (checked by the tests).
  static GROUPS = Object.freeze({
    sales: Object.freeze([
      ["invoice", "Invoice & header", ["invoice_id", "invoice_date", "invoice_due_date", "invoice_date_month_start", "invoice_status", "is_invoice_cancelled", "is_invoice_closed", "invoice_terms_description", "Order_No", "external_document_no", "Company", "Location_Code", "warehouse", "Ship_to_Code", "Ship_to_Name", "Ship_to_City"]],
      ["customer", "Customer", ["customer_id", "customer_name", "finalCustID", "category", "classification", "type", "level"]],
      ["line", "Sales line", ["Line_No", "invoice_item_id", "invoice_item_name", "item_name", "Description_2", "No", "invoice_item_quantity_sales", "invoice_item_quantity", "invoice_item_quantity_uom_item_base", "Quantity", "uom_code", "uom_displayName", "uom", "uom_qty", "uom_base"]],
      ["product", "Product classification", ["category_1", "category_2", "category_3", "subcategory", "main_product", "product_grouping", "business_unit_2026", "new_main_product_database_v2"]],
      ["attribution", "Sales attribution", ["Salesperson_Code", "territory_sales", "region", "territory_whitelisted_config", "Custom.2", "territorytest_try"]],
      ["source", "Source", ["sales_data_source", "sales_data_type", "sales_type", "Data_Table"]],
      ["technical", "Technical identifiers", ["join_key_Company_Invoice", "join_key_Invoice_CustLedger", "join_key_bc_company_item_uom", "join_key_bc_valueEntries_Sales_Invoice", "join_key_company_salesperson_code", "connect_to_rmr", "connect_to_salescreditmemo", "Ref", "pulse_id_customer_db", "pulse_id_whitelisted_account", "pulse_id_territory_database", "pulse_id_territory_database_2025_w_whitelisted", "pulse_id_territory_db_with_distributors", "pulse_id_territory_with_distributors_try", "pulse_id_product_db", "pulse_id_main_product_db", "pulse_id_new_main_product_db", "is_tagged_product_db", "is_tagged_main_product_db", "is_tagged_customer_db", "is_tagged_territory_db", "Text", "Custom", "custom_1"]],
      ["financial", "Financial & cost", ["Unit_Price", "invoice_item_amount_sales", "invoice_item_amount", "invoice_total_amount", "landed_cost"]]
    ]),
    inventory: Object.freeze([
      ["item", "Item", ["Item_No", "Item_Description", "item_name", "Description", "Variant_Code", "Unit_of_Measure_Code", "Qty_per_Unit_of_Measure", "uom", "uom_base", "category_1", "category_2", "category_3", "subcategory", "Serial_No", "Lot_No", "Package_No", "Expiration_Date"]],
      ["entry", "Ledger entry", ["Entry_No", "Entry_Type", "Document_Type", "Transfer_Type", "Open", "Completely_Invoiced", "Drop_Shipment", "Assemble_to_Order", "Applied_Entry_to_Adjust", "Return_Reason_Code", "Customer_Code", "Source_Type", "Source_No", "Source_Description"]],
      ["location", "Company & location", ["Company", "Location_Code", "warehouse_company", "warehouse_code", "warehouse_name", "warehouse_address", "warehouse_post_code", "warehouse_city", "warehouse_country_region_code"]],
      ["quantities", "Quantities", ["Quantity", "Remaining_Quantity", "Invoiced_Quantity", "Remaining_Qty_by_Date", "Shipped_Qty_Not_Returned", "Reserved_Quantity", "RunningBalance", "RunningBalanceLoc"]],
      ["documents", "Document references", ["Document_No", "External_Document_No", "Document_Line_No", "Order_Type", "Order_No", "Order_Line_No", "Prod_Order_Comp_Line_No", "Source_Order_No", "Job_No", "Job_Task_No"]],
      ["posting", "Posting", ["Posting_Date", "Global_Dimension_1_Code", "Global_Dimension_2_Code", "Shortcut_Dimension_3_Code", "Shortcut_Dimension_4_Code", "Shortcut_Dimension_5_Code", "Shortcut_Dimension_6_Code", "Shortcut_Dimension_7_Code", "Shortcut_Dimension_8_Code", "Dimension_Set_ID", "Date_Filter", "date_today"]],
      ["cost", "Amounts & cost", ["Sales_Amount_Expected", "Sales_Amount_Actual", "Cost_Amount_Expected", "Cost_Amount_Actual", "Cost_Amount_Non_Invtbl", "Cost_Amount_Expected_ACY", "Cost_Amount_Actual_ACY", "Cost_Amount_Non_Invtbl_ACY", "landed_cost", "distributors_price", "trade_price"]],
      ["technical", "Technical identifiers", ["join_key_bc_company_item_uom", "join_key_warehouse_company_code", "pulse_id_product_db", "pulse_id_new_main_product_db", "new_main_product_database_v2", "ETag"]]
    ])
  });
  static OTHER = Object.freeze({ id: "other", title: "Other" });
  // The display record key (datasets.js recordKey) and the join/connect keys shown on the Keys tab.
  static RECORD_KEYS = Object.freeze({ sales: Object.freeze(["Company", "invoice_id", "Line_No"]), inventory: Object.freeze(["Company", "Entry_No"]) });
  static JOIN_KEYS = Object.freeze({
    sales: Object.freeze(["join_key_Company_Invoice", "join_key_Invoice_CustLedger", "join_key_bc_company_item_uom", "join_key_bc_valueEntries_Sales_Invoice", "join_key_company_salesperson_code", "connect_to_rmr", "connect_to_salescreditmemo", "Ref"]),
    inventory: Object.freeze(["join_key_bc_company_item_uom", "join_key_warehouse_company_code"])
  });
  // Identifier-like values: shown in the mono font.
  static MONO = /^(join_key_|connect_to_|pulse_id_)|^(Ref|ETag|Dimension_Set_ID)$/;
  // Labels where the generic rule (underscores → spaces, sentence case) would read badly.
  static LABELS = Object.freeze({
    common: Object.freeze({
      Company: "Company", Location_Code: "Location code", Order_No: "Order no.", Quantity: "Quantity", uom: "Unit of measure", uom_base: "Base unit of measure",
      category_1: "Category 1", category_2: "Category 2", category_3: "Category 3", subcategory: "Subcategory", item_name: "Item name", landed_cost: "Landed cost",
      join_key_bc_company_item_uom: "Join key: company · item · unit", pulse_id_product_db: "Pulse ID: product DB", pulse_id_new_main_product_db: "Pulse ID: new main product DB",
      new_main_product_database_v2: "New main product database (v2)"
    }),
    sales: Object.freeze({
      invoice_id: "Invoice no.", customer_name: "Customer name", invoice_due_date: "Due date", external_document_no: "External document no.", Salesperson_Code: "Salesperson code",
      is_invoice_cancelled: "Cancelled", is_invoice_closed: "Closed", invoice_terms_description: "Payment terms", Ship_to_Code: "Ship-to code", Ship_to_Name: "Ship-to name",
      Ship_to_City: "Ship-to city", Line_No: "Line no.", customer_id: "Customer ID", invoice_item_id: "Item no.", invoice_item_name: "Item description", Description_2: "Description 2",
      invoice_item_quantity_sales: "Quantity (sales)", uom_code: "Unit of measure code", uom_displayName: "Unit of measure name", invoice_item_amount_sales: "Line amount (sales)",
      Unit_Price: "Unit price", invoice_total_amount: "Invoice total (source)", sales_data_source: "Sales data source", finalCustID: "Final customer ID",
      pulse_id_territory_database_2025_w_whitelisted: "Pulse ID: territory DB 2025 (whitelisted)", pulse_id_territory_database: "Pulse ID: territory DB", pulse_id_customer_db: "Pulse ID: customer DB",
      No: "No.", Data_Table: "Data table", category: "Customer category", classification: "Customer classification", type: "Customer type", level: "Customer level",
      pulse_id_territory_db_with_distributors: "Pulse ID: territory DB with distributors", business_unit_2026: "Business unit (2026)", pulse_id_main_product_db: "Pulse ID: main product DB",
      main_product: "Main product", product_grouping: "Product grouping", invoice_item_quantity: "Quantity (line)", Quantity: "Quantity (source column)",
      invoice_item_amount: "Line amount", uom_qty: "Unit of measure quantity",
      invoice_item_quantity_uom_item_base: "Quantity (base unit)", join_key_bc_valueEntries_Sales_Invoice: "Join key: value entries · sales invoice", invoice_date: "Invoice date",
      warehouse: "Warehouse", invoice_status: "Invoice status", territory_sales: "Sales territory", sales_data_type: "Sales data type", is_tagged_product_db: "Tagged in product DB",
      is_tagged_main_product_db: "Tagged in main product DB", is_tagged_customer_db: "Tagged in customer DB", is_tagged_territory_db: "Tagged in territory DB",
      invoice_date_month_start: "Invoice month", sales_type: "Sales type", pulse_id_whitelisted_account: "Pulse ID: whitelisted account", territory_whitelisted_config: "Territory (whitelisted config)",
      region: "Region", join_key_Invoice_CustLedger: "Join key: invoice · customer ledger", join_key_Company_Invoice: "Join key: company · invoice",
      join_key_company_salesperson_code: "Join key: company · salesperson", Text: "Text", Custom: "Custom", territorytest_try: "Territory (test)", custom_1: "Custom 1",
      pulse_id_territory_with_distributors_try: "Pulse ID: territory with distributors (test)", connect_to_rmr: "Connect: RMR", connect_to_salescreditmemo: "Connect: sales credit memo",
      "Custom.2": "Custom 2", Ref: "Reference"
    }),
    inventory: Object.freeze({
      Entry_No: "Entry no.", Posting_Date: "Posting date", Entry_Type: "Entry type", Document_Type: "Document type", Document_No: "Document no.", External_Document_No: "External document no.",
      Document_Line_No: "Document line no.", Item_No: "Item no.", Item_Description: "Item description", Variant_Code: "Variant code", Description: "Description", Transfer_Type: "Transfer type",
      Customer_Code: "Customer code", Return_Reason_Code: "Return reason code", Global_Dimension_1_Code: "Global dimension 1", Global_Dimension_2_Code: "Global dimension 2",
      Expiration_Date: "Expiration date", Serial_No: "Serial no.", Lot_No: "Lot no.", Package_No: "Package no.", RunningBalance: "Running balance", RunningBalanceLoc: "Running balance (location)",
      Invoiced_Quantity: "Invoiced quantity", Remaining_Quantity: "Remaining quantity", Remaining_Qty_by_Date: "Remaining quantity by date", Shipped_Qty_Not_Returned: "Shipped quantity not returned",
      Reserved_Quantity: "Reserved quantity", Qty_per_Unit_of_Measure: "Quantity per unit of measure", Unit_of_Measure_Code: "Unit of measure code",
      Sales_Amount_Expected: "Sales amount (expected)", Sales_Amount_Actual: "Sales amount (actual)", Cost_Amount_Expected: "Cost amount (expected)", Cost_Amount_Actual: "Cost amount (actual)",
      Cost_Amount_Non_Invtbl: "Cost amount (non-inventoriable)", Cost_Amount_Expected_ACY: "Cost amount (expected, ACY)", Cost_Amount_Actual_ACY: "Cost amount (actual, ACY)",
      Cost_Amount_Non_Invtbl_ACY: "Cost amount (non-inventoriable, ACY)", Completely_Invoiced: "Completely invoiced", Open: "Open", Drop_Shipment: "Drop shipment",
      Assemble_to_Order: "Assemble to order", Applied_Entry_to_Adjust: "Applied entry to adjust", Order_Type: "Order type", Order_Line_No: "Order line no.",
      Prod_Order_Comp_Line_No: "Production order component line no.", Job_No: "Job no.", Job_Task_No: "Job task no.", Dimension_Set_ID: "Dimension set ID",
      Shortcut_Dimension_3_Code: "Shortcut dimension 3", Shortcut_Dimension_4_Code: "Shortcut dimension 4", Shortcut_Dimension_5_Code: "Shortcut dimension 5",
      Shortcut_Dimension_6_Code: "Shortcut dimension 6", Shortcut_Dimension_7_Code: "Shortcut dimension 7", Shortcut_Dimension_8_Code: "Shortcut dimension 8",
      Source_Type: "Source type", Source_No: "Source no.", Source_Description: "Source description", Source_Order_No: "Source order no.", Date_Filter: "Date filter", ETag: "ETag",
      warehouse_company: "Warehouse company", warehouse_code: "Warehouse code", warehouse_name: "Warehouse name", warehouse_address: "Warehouse address",
      warehouse_post_code: "Warehouse post code", warehouse_city: "Warehouse city", warehouse_country_region_code: "Warehouse country/region",
      join_key_warehouse_company_code: "Join key: warehouse company · code", distributors_price: "Distributors' price", trade_price: "Trade price", date_today: "Snapshot date"
    })
  });

  static known(dataset) { return Object.hasOwn(FabricFieldMeta.GROUPS, dataset) ? dataset : ""; }
  // The raw name with "_" → space (and "." → space), sentence case: the fallback for a field without a label.
  static humanize(name) {
    const t = String(name ?? "").replace(/[_.]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
    return t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : "";
  }
  static label(dataset, field) {
    const name = String(field ?? ""), ds = FabricFieldMeta.known(dataset), own = ds ? FabricFieldMeta.LABELS[ds] : null;
    if (own && Object.hasOwn(own, name)) return own[name];
    if (ds && FabricFieldMeta.verified(ds).includes(name) && Object.hasOwn(FabricFieldMeta.LABELS.common, name)) return FabricFieldMeta.LABELS.common[name];
    return FabricFieldMeta.humanize(name);
  }
  // Every verified field of a dataset, in group order.
  static verified(dataset) { const ds = FabricFieldMeta.known(dataset); return ds ? FabricFieldMeta.GROUPS[ds].flatMap(([, , f]) => f) : []; }
  // [{ id, title, fields[] }]: the verified groups (copies; callers may filter them). An unknown dataset has no groups.
  static groups(dataset) { const ds = FabricFieldMeta.known(dataset); return ds ? FabricFieldMeta.GROUPS[ds].map(([id, title, fields]) => ({ id, title, fields: [...fields] })) : []; }
  static groupOf(dataset, field) { const g = FabricFieldMeta.groups(dataset).find((x) => x.fields.includes(field)); return g ? g.id : FabricFieldMeta.OTHER.id; }
  // The given field names (what a response holds) arranged into groups: empty groups dropped, unknown names in "Other" so nothing
  // is lost. Order inside a group follows the group's own order; "Other" keeps the order given.
  static arrange(dataset, names) {
    const present = new Set((Array.isArray(names) ? names : []).filter((n) => typeof n === "string"));
    const out = FabricFieldMeta.groups(dataset).map((g) => ({ ...g, fields: g.fields.filter((f) => present.has(f)) })).filter((g) => g.fields.length);
    const placed = new Set(out.flatMap((g) => g.fields)), other = [...present].filter((n) => !placed.has(n));
    if (other.length) out.push({ ...FabricFieldMeta.OTHER, fields: other });
    return out;
  }
  static isKey(dataset, field) { const ds = FabricFieldMeta.known(dataset); return Boolean(ds) && FabricFieldMeta.RECORD_KEYS[ds].includes(field); }
  static recordKey(dataset) { const ds = FabricFieldMeta.known(dataset); return ds ? [...FabricFieldMeta.RECORD_KEYS[ds]] : []; }
  static joinKeys(dataset) { const ds = FabricFieldMeta.known(dataset); return ds ? [...FabricFieldMeta.JOIN_KEYS[ds]] : []; }
  static isMono(field) { return FabricFieldMeta.MONO.test(String(field ?? "")); }
  // Identifier-like fields (line, entry and document numbers, IDs): their whole numbers are shown without digit grouping
  // ("10000", not "10,000"). Quantities and amounts keep grouping.
  static IDENT = /(^|_)(No|ID|Id|id)$|ID$/;
  static isIdentifier(field) { return FabricFieldMeta.IDENT.test(String(field ?? "")); }

  // ---- Values → { text, cls, title }. Text is plain (callers escape it); cls is a space-separated class list.
  static NONE = Object.freeze({ text: "—", cls: "fx-null", title: "No value" });
  static NUMERIC = new Set(["number", "int", "long", "double", "decimal", "integer", "float"]);
  static separators() {
    if (FabricFieldMeta.seps) return FabricFieldMeta.seps;
    let group = ",", decimal = ".";
    try { for (const p of new Intl.NumberFormat().formatToParts(1234567.5)) { if (p.type === "group") group = p.value; else if (p.type === "decimal") decimal = p.value; } } catch { /* defaults */ }
    FabricFieldMeta.seps = { group, decimal };
    return FabricFieldMeta.seps;
  }
  // An exact decimal string (Decimal128.toString(), a Long as a string): digit grouping added, nothing rounded or dropped.
  // Exponent forms ("1.5E+3") and anything else unexpected are shown exactly as received.
  static exact(s) {
    const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) return s;
    const { group, decimal } = FabricFieldMeta.separators();
    return `${m[1] === "-" ? "-" : ""}${m[2].replace(/\B(?=(\d{3})+(?!\d))/g, group)}${m[3] !== undefined ? decimal + m[3] : ""}`;
  }
  static date(value) {
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) return null;
    const iso = d.toISOString(), day = iso.slice(0, 10), time = iso.slice(11, 19);
    return { text: time === "00:00:00" ? day : `${day} ${time.slice(0, 5)} UTC`, title: iso };
  }
  static format(value, type, field) {
    const t = String(type ?? "").toLowerCase();
    if (value === null || value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value))) return { ...FabricFieldMeta.NONE };
    if (typeof value === "boolean") return { text: value ? "Yes" : "No", cls: "fx-bool", title: value ? "Yes" : "No" };
    const mono = FabricFieldMeta.isMono(field) ? " fx-mono" : "";
    if (t === "date" && (typeof value === "string" || value instanceof Date)) { const d = FabricFieldMeta.date(value); if (d) return { text: d.text, cls: "fx-date", title: d.title }; }
    const ident = FabricFieldMeta.isIdentifier(field);
    if (ident && typeof value === "number" && Number.isInteger(value)) return { text: String(value), cls: "fx-num fx-id", title: String(value) };
    if (ident && typeof value === "string" && FabricFieldMeta.NUMERIC.has(t) && /^[+-]?\d+$/.test(value.trim())) return { text: value.trim(), cls: "fx-num fx-id", title: value };
    if (typeof value === "number") {
      let text;
      try { text = value.toLocaleString(undefined, { maximumFractionDigits: 20 }); } catch { text = String(value); }
      return { text, cls: "fx-num", title: String(value) };
    }
    if (typeof value === "string" && FabricFieldMeta.NUMERIC.has(t)) return { text: FabricFieldMeta.exact(value.trim()), cls: "fx-num", title: value };
    if (Array.isArray(value)) { const text = value.map((v) => FabricFieldMeta.format(v, "", field).text).join(", "); return { text, cls: `fx-list${mono}`, title: text }; }
    if (typeof value === "object") { let text = ""; try { text = JSON.stringify(value); } catch { text = ""; } return text ? { text, cls: `fx-json${mono}`, title: text } : { ...FabricFieldMeta.NONE }; }
    const text = String(value);
    return { text, cls: `fx-text${mono}`, title: text };
  }
}
if (typeof window !== "undefined") window.FabricFieldMeta = FabricFieldMeta;
