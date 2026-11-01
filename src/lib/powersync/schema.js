import { column, Schema, Table } from '@powersync/web';

// Mirrors what the Sync Streams config makes available locally.
// Types are limited to text / integer / real (SQLite's types) — PowerSync
// casts automatically from Postgres's types. No need to declare an `id`
// column; PowerSync adds that automatically.

const drugs = new Table({
  owner_shop_id: column.text, // null = shared catalogue; set = private to that shop
  name: column.text,
  generic_name: column.text,
  category: column.text,
  form: column.text,
  strength: column.text,
  requires_prescription: column.integer, // 0 / 1
  ven_classification: column.text,
  unit_of_sale: column.text,
});

const suppliers = new Table({
  name: column.text,
  contact_phone: column.text,
  contact_email: column.text,
  average_lead_time_days: column.integer,
});

const batches = new Table({
  shop_id: column.text,
  drug_id: column.text,
  supplier_id: column.text,
  batch_number: column.text,
  expiry_date: column.text,
  cost_price: column.real,
  selling_price: column.real,
  quantity_received: column.integer,
  quantity_remaining: column.integer,
  received_at: column.text,
});

const inventory_policy = new Table({
  shop_id: column.text,
  drug_id: column.text,
  safety_stock_units: column.integer,
  max_stock_units: column.integer,
});

const staff = new Table({
  shop_id: column.text,
  full_name: column.text,
  role: column.text,
  auth_user_id: column.text,
});

// These local-only outbox tables are flushed explicitly by flush.js, which
// lets pending transactions survive a sign-out without entering the CRUD queue.
const pending_sales = new Table({
  created_by_user_id: column.text,
  shop_id: column.text,
  payment_method: column.text,
  items_json: column.text, // JSON-encoded array of {drug_id, batch_id, quantity, unit_price}
  total_amount: column.real,
  prescription_reference: column.text,
  prescriber_name: column.text,
  prescription_date: column.text,
  created_at: column.text,
  status: column.text,
  last_error: column.text,
}, { localOnly: true });

const pending_receipts = new Table({
  created_by_user_id: column.text,
  shop_id: column.text,
  drug_id: column.text,
  supplier_id: column.text,   // nullable — empty string if using supplier_name instead
  supplier_name: column.text, // nullable — used when supplier_id is empty
  batch_number: column.text,
  expiry_date: column.text,
  cost_price: column.real,
  selling_price: column.real,
  quantity: column.integer,
  // 1 = POM, 0 = OTC, null = existing stocked drug / no first-stock choice.
  initial_requires_prescription: column.integer,
  created_at: column.text,
  status: column.text,
  last_error: column.text,
}, { localOnly: true });

const shop_drugs = new Table({
  shop_id: column.text,
  drug_id: column.text,
  // 1 = POM, 0 = OTC, null = legacy relationship awaiting classification.
  requires_prescription: column.integer,
  added_at: column.text,
});


export const AppSchema = new Schema({
  drugs,
  suppliers,
  batches,
  inventory_policy,
  staff,
  pending_sales,
  pending_receipts,
  shop_drugs,
});