// Database schema. All money is stored in base currency (INR) unless a column says otherwise.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0, permissions TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id),
  is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequences (
  type TEXT PRIMARY KEY, prefix TEXT NOT NULL, next_no INTEGER NOT NULL DEFAULT 1, padding INTEGER NOT NULL DEFAULT 5
);
CREATE TABLE IF NOT EXISTS currencies (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL, rate REAL NOT NULL DEFAULT 1, is_base INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, type TEXT NOT NULL,
  parent_id INTEGER REFERENCES accounts(id), description TEXT,
  system_key TEXT UNIQUE, is_active INTEGER NOT NULL DEFAULT 1,
  bank_name TEXT, account_number TEXT, ifsc TEXT, currency_code TEXT NOT NULL DEFAULT 'INR',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS taxes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, rate REAL NOT NULL, kind TEXT NOT NULL DEFAULT 'gst',
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tds_sections (
  id INTEGER PRIMARY KEY, section TEXT NOT NULL, name TEXT NOT NULL, rate REAL NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT, address TEXT, state_code TEXT, gstin TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS price_lists (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'sales', mode TEXT NOT NULL DEFAULT 'percentage',
  percentage REAL NOT NULL DEFAULT 0, description TEXT, is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS price_list_items (
  price_list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, rate REAL NOT NULL,
  PRIMARY KEY (price_list_id, item_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('customer','vendor')), name TEXT NOT NULL,
  company_name TEXT, email TEXT, phone TEXT, gst_treatment TEXT NOT NULL DEFAULT 'business_gst', gstin TEXT, pan TEXT,
  place_of_supply TEXT, billing_address TEXT, shipping_address TEXT, payment_terms INTEGER NOT NULL DEFAULT 0,
  currency_code TEXT NOT NULL DEFAULT 'INR', credit_limit REAL, price_list_id INTEGER REFERENCES price_lists(id),
  opening_balance REAL NOT NULL DEFAULT 0, tds_section_id INTEGER REFERENCES tds_sections(id),
  notes TEXT, is_active INTEGER NOT NULL DEFAULT 1, custom TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_kind ON contacts(kind, name);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, sku TEXT UNIQUE, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'goods' CHECK (type IN ('goods','service')),
  unit TEXT NOT NULL DEFAULT 'pcs', hsn_code TEXT, tax_preference TEXT NOT NULL DEFAULT 'taxable', tax_id INTEGER REFERENCES taxes(id),
  sales_rate REAL NOT NULL DEFAULT 0, purchase_rate REAL NOT NULL DEFAULT 0,
  sales_account_id INTEGER REFERENCES accounts(id), purchase_account_id INTEGER REFERENCES accounts(id),
  inventory_account_id INTEGER REFERENCES accounts(id),
  track_inventory INTEGER NOT NULL DEFAULT 1, tracking TEXT NOT NULL DEFAULT 'none' CHECK (tracking IN ('none','batch','serial')),
  reorder_level REAL NOT NULL DEFAULT 0, preferred_vendor_id INTEGER REFERENCES contacts(id),
  opening_stock TEXT NOT NULL DEFAULT '[]', description TEXT, is_active INTEGER NOT NULL DEFAULT 1,
  custom TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, number TEXT NOT NULL, date TEXT NOT NULL, due_date TEXT,
  contact_id INTEGER REFERENCES contacts(id), status TEXT NOT NULL DEFAULT 'draft',
  fulfil_status TEXT, billing_status TEXT, approval_level INTEGER NOT NULL DEFAULT 0,
  warehouse_id INTEGER REFERENCES warehouses(id), to_warehouse_id INTEGER REFERENCES warehouses(id),
  currency_code TEXT NOT NULL DEFAULT 'INR', exchange_rate REAL NOT NULL DEFAULT 1,
  place_of_supply TEXT, gst_treatment TEXT, gstin TEXT, reverse_charge INTEGER NOT NULL DEFAULT 0,
  tax_inclusive INTEGER NOT NULL DEFAULT 0,
  reference TEXT, salesperson TEXT, payment_terms INTEGER, ref_doc_id INTEGER REFERENCES documents(id),
  subtotal REAL NOT NULL DEFAULT 0, discount_total REAL NOT NULL DEFAULT 0, taxable_total REAL NOT NULL DEFAULT 0,
  cgst_total REAL NOT NULL DEFAULT 0, sgst_total REAL NOT NULL DEFAULT 0, igst_total REAL NOT NULL DEFAULT 0,
  cess_total REAL NOT NULL DEFAULT 0, tax_total REAL NOT NULL DEFAULT 0, tds_amount REAL NOT NULL DEFAULT 0,
  adjustment REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, balance REAL NOT NULL DEFAULT 0,
  notes TEXT, terms TEXT, data TEXT NOT NULL DEFAULT '{}', custom TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT,
  UNIQUE (type, number)
);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type, date);
CREATE INDEX IF NOT EXISTS idx_documents_contact ON documents(contact_id);
CREATE INDEX IF NOT EXISTS idx_documents_ref ON documents(ref_doc_id);

CREATE TABLE IF NOT EXISTS document_lines (
  id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, line_no INTEGER NOT NULL DEFAULT 0,
  item_id INTEGER REFERENCES items(id), account_id INTEGER REFERENCES accounts(id), description TEXT, hsn_code TEXT, unit TEXT,
  qty REAL NOT NULL DEFAULT 0, qty2 REAL, rate REAL NOT NULL DEFAULT 0, discount_pct REAL NOT NULL DEFAULT 0,
  tax_id INTEGER REFERENCES taxes(id), tax_rate REAL NOT NULL DEFAULT 0, tax_exempt TEXT,
  taxable REAL NOT NULL DEFAULT 0, cgst REAL NOT NULL DEFAULT 0, sgst REAL NOT NULL DEFAULT 0, igst REAL NOT NULL DEFAULT 0,
  cess REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0, landed_cost REAL NOT NULL DEFAULT 0,
  ref_line_id INTEGER, warehouse_id INTEGER REFERENCES warehouses(id), itc_eligible INTEGER NOT NULL DEFAULT 1,
  tracking TEXT NOT NULL DEFAULT '[]', data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_lines_doc ON document_lines(document_id);
CREATE INDEX IF NOT EXISTS idx_lines_ref ON document_lines(ref_line_id);
CREATE INDEX IF NOT EXISTS idx_lines_item ON document_lines(item_id);

CREATE TABLE IF NOT EXISTS rfq_bids (
  id INTEGER PRIMARY KEY, rfq_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES contacts(id), line_id INTEGER NOT NULL REFERENCES document_lines(id) ON DELETE CASCADE,
  rate REAL NOT NULL, lead_days INTEGER, notes TEXT, awarded INTEGER NOT NULL DEFAULT 0, surrogate INTEGER NOT NULL DEFAULT 1,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (rfq_id, vendor_id, line_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('received','made')), number TEXT NOT NULL, date TEXT NOT NULL,
  contact_id INTEGER NOT NULL REFERENCES contacts(id), amount REAL NOT NULL, bank_charges REAL NOT NULL DEFAULT 0,
  tds_amount REAL NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'bank_transfer', account_id INTEGER NOT NULL REFERENCES accounts(id),
  reference TEXT, currency_code TEXT NOT NULL DEFAULT 'INR', exchange_rate REAL NOT NULL DEFAULT 1, notes TEXT,
  status TEXT NOT NULL DEFAULT 'paid', created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (kind, number)
);
CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id), amount REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alloc_doc ON payment_allocations(document_id);
CREATE TABLE IF NOT EXISTS credit_applications (
  id INTEGER PRIMARY KEY, credit_doc_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  payment_id INTEGER REFERENCES payments(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, amount REAL NOT NULL, date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, credit_doc_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  payment_id INTEGER REFERENCES payments(id) ON DELETE CASCADE, contact_id INTEGER NOT NULL REFERENCES contacts(id),
  date TEXT NOT NULL, amount REAL NOT NULL, account_id INTEGER NOT NULL REFERENCES accounts(id), mode TEXT, reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS journals (
  id INTEGER PRIMARY KEY, number TEXT, date TEXT NOT NULL, source_type TEXT NOT NULL, source_id INTEGER,
  memo TEXT, reference TEXT, is_manual INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'posted',
  data TEXT NOT NULL DEFAULT '{}', created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_journals_source ON journals(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_journals_date ON journals(date);
CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY, journal_id INTEGER NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id), debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0,
  contact_id INTEGER REFERENCES contacts(id), item_id INTEGER REFERENCES items(id), description TEXT,
  recon_id INTEGER REFERENCES reconciliations(id)
);
CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_jl_journal ON journal_lines(journal_id);

CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  date TEXT NOT NULL, qty REAL NOT NULL, physical INTEGER NOT NULL DEFAULT 1, accounting INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL, unit_cost REAL, value REAL NOT NULL DEFAULT 0, value_delta REAL NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL, source_id INTEGER NOT NULL, source_line_id INTEGER, ref_source_line_id INTEGER,
  batch_no TEXT, serial_no TEXT, expiry_date TEXT, in_transit INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sm_item ON stock_moves(item_id, date);
CREATE INDEX IF NOT EXISTS idx_sm_source ON stock_moves(source_type, source_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, user_id INTEGER, entity TEXT NOT NULL,
  entity_id INTEGER, action TEXT NOT NULL, summary TEXT, data TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY, entity TEXT NOT NULL, entity_id INTEGER NOT NULL, user_id INTEGER, body TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT,
  link TEXT, is_read INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT, entity TEXT, entity_id INTEGER,
  status TEXT NOT NULL DEFAULT 'queued', at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS approval_history (
  id INTEGER PRIMARY KEY, entity TEXT NOT NULL, entity_id INTEGER NOT NULL, level INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL, user_id INTEGER, comment TEXT, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workflow_rules (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, module TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT 'on_create',
  conditions TEXT NOT NULL DEFAULT '[]', actions TEXT NOT NULL DEFAULT '[]', is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workflow_log (
  id INTEGER PRIMARY KEY, rule_id INTEGER, entity TEXT, entity_id INTEGER, result TEXT, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS custom_fields (
  id INTEGER PRIMARY KEY, module TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text',
  options TEXT NOT NULL DEFAULT '[]', required INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, UNIQUE (module, key)
);
CREATE TABLE IF NOT EXISTS custom_modules (
  id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT NOT NULL, plural TEXT NOT NULL, prefix TEXT NOT NULL DEFAULT 'REC-',
  fields TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS custom_records (
  id INTEGER PRIMARY KEY, module_id INTEGER NOT NULL REFERENCES custom_modules(id) ON DELETE CASCADE, number TEXT,
  data TEXT NOT NULL DEFAULT '{}', created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS recurring_profiles (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, doc_type TEXT NOT NULL DEFAULT 'invoice', contact_id INTEGER NOT NULL REFERENCES contacts(id),
  frequency TEXT NOT NULL DEFAULT 'monthly', every INTEGER NOT NULL DEFAULT 1, start_date TEXT NOT NULL, end_date TEXT,
  next_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', template TEXT NOT NULL DEFAULT '{}',
  auto_send INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Banking
CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), date TEXT NOT NULL, description TEXT,
  reference TEXT, deposit REAL NOT NULL DEFAULT 0, withdrawal REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uncategorized', matched_source_type TEXT, matched_source_id INTEGER,
  import_batch TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY, number TEXT, kind TEXT NOT NULL, date TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES accounts(id),
  offset_account_id INTEGER NOT NULL REFERENCES accounts(id), amount REAL NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  contact_id INTEGER REFERENCES contacts(id), description TEXT, reference TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reconciliations (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  closing_balance REAL NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

-- Fixed assets
CREATE TABLE IF NOT EXISTS asset_types (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, asset_account_id INTEGER NOT NULL REFERENCES accounts(id),
  depreciation_account_id INTEGER NOT NULL REFERENCES accounts(id), accumulated_account_id INTEGER NOT NULL REFERENCES accounts(id),
  method TEXT NOT NULL DEFAULT 'slm', useful_life_months INTEGER NOT NULL DEFAULT 60, wdv_rate REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, name TEXT NOT NULL, asset_type_id INTEGER NOT NULL REFERENCES asset_types(id),
  serial_no TEXT, location TEXT, purchase_date TEXT NOT NULL, depreciation_start TEXT NOT NULL, cost REAL NOT NULL,
  salvage_value REAL NOT NULL DEFAULT 0, method TEXT NOT NULL DEFAULT 'slm', useful_life_months INTEGER NOT NULL DEFAULT 60,
  wdv_rate REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', vendor_id INTEGER REFERENCES contacts(id),
  acquisition_account_id INTEGER REFERENCES accounts(id), disposal_date TEXT, disposal_amount REAL, disposal_account_id INTEGER,
  notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS asset_depreciation (
  id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE, period_end TEXT NOT NULL,
  amount REAL NOT NULL, journal_id INTEGER REFERENCES journals(id), UNIQUE (asset_id, period_end)
);

-- Budgets
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, fiscal_year INTEGER NOT NULL, period TEXT NOT NULL DEFAULT 'monthly',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS budget_lines (
  id INTEGER PRIMARY KEY, budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id), amounts TEXT NOT NULL DEFAULT '[]', UNIQUE (budget_id, account_id)
);

-- Manufacturing
CREATE TABLE IF NOT EXISTS work_centers (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, cost_per_hour REAL NOT NULL DEFAULT 0,
  capacity_hours REAL NOT NULL DEFAULT 8, description TEXT, is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS boms (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, name TEXT NOT NULL, item_id INTEGER NOT NULL REFERENCES items(id),
  quantity REAL NOT NULL DEFAULT 1, overhead_cost REAL NOT NULL DEFAULT 0, is_default INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active', notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bom_components (
  id INTEGER PRIMARY KEY, bom_id INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE, item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL, wastage_pct REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bom_operations (
  id INTEGER PRIMARY KEY, bom_id INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE, seq INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL, work_center_id INTEGER NOT NULL REFERENCES work_centers(id), minutes REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS manufacturing_orders (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, date TEXT NOT NULL, bom_id INTEGER NOT NULL REFERENCES boms(id),
  item_id INTEGER NOT NULL REFERENCES items(id), qty REAL NOT NULL, warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'draft', planned_start TEXT, planned_end TEXT, completed_date TEXT,
  sales_order_id INTEGER REFERENCES documents(id), produced_qty REAL NOT NULL DEFAULT 0, rejected_qty REAL NOT NULL DEFAULT 0,
  overhead_cost REAL NOT NULL DEFAULT 0, labour_cost REAL NOT NULL DEFAULT 0, material_cost REAL NOT NULL DEFAULT 0,
  output_tracking TEXT NOT NULL DEFAULT '[]', notes TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mo_components (
  id INTEGER PRIMARY KEY, mo_id INTEGER NOT NULL REFERENCES manufacturing_orders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id), required_qty REAL NOT NULL, consumed_qty REAL NOT NULL DEFAULT 0,
  tracking TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS job_cards (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, mo_id INTEGER NOT NULL REFERENCES manufacturing_orders(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL, work_center_id INTEGER NOT NULL REFERENCES work_centers(id),
  planned_minutes REAL NOT NULL DEFAULT 0, actual_minutes REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
  employee_id INTEGER REFERENCES employees(id), planned_start TEXT, started_at TEXT, completed_at TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS job_card_logs (
  id INTEGER PRIMARY KEY, job_card_id INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE, started_at TEXT NOT NULL,
  ended_at TEXT, minutes REAL NOT NULL DEFAULT 0, employee_id INTEGER, notes TEXT
);
CREATE TABLE IF NOT EXISTS quality_rules (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, item_id INTEGER NOT NULL REFERENCES items(id), applies_to TEXT NOT NULL DEFAULT 'both',
  parameters TEXT NOT NULL DEFAULT '[]', is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS quality_inspections (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, date TEXT NOT NULL, source_type TEXT NOT NULL, source_id INTEGER NOT NULL,
  source_line_id INTEGER, item_id INTEGER NOT NULL REFERENCES items(id), qty REAL NOT NULL, accepted_qty REAL NOT NULL DEFAULT 0,
  rejected_qty REAL NOT NULL DEFAULT 0, results TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
  inspector TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- People & payroll
CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS designations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY, emp_code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT, phone TEXT, gender TEXT,
  dob TEXT, doj TEXT NOT NULL, exit_date TEXT, department_id INTEGER REFERENCES departments(id),
  designation_id INTEGER REFERENCES designations(id), work_state TEXT, pan TEXT, uan TEXT, esi_number TEXT,
  bank_name TEXT, bank_account TEXT, ifsc TEXT, annual_ctc REAL NOT NULL DEFAULT 0, components TEXT NOT NULL DEFAULT '{}',
  pf_enabled INTEGER NOT NULL DEFAULT 1, esi_enabled INTEGER NOT NULL DEFAULT 1, pt_enabled INTEGER NOT NULL DEFAULT 1,
  tds_enabled INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS salary_components (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'earning',
  calc TEXT NOT NULL DEFAULT 'fixed', value REAL NOT NULL DEFAULT 0, pf_applicable INTEGER NOT NULL DEFAULT 0,
  esi_applicable INTEGER NOT NULL DEFAULT 1, taxable INTEGER NOT NULL DEFAULT 1, is_active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pt_slabs (
  id INTEGER PRIMARY KEY, state_code TEXT NOT NULL, min_salary REAL NOT NULL, max_salary REAL,
  amount REAL NOT NULL, feb_amount REAL
);
CREATE TABLE IF NOT EXISTS pay_runs (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, period TEXT NOT NULL UNIQUE, pay_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', paid_account_id INTEGER REFERENCES accounts(id), paid_date TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payslips (
  id INTEGER PRIMARY KEY, pay_run_id INTEGER NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id), days INTEGER NOT NULL, lop_days REAL NOT NULL DEFAULT 0,
  paid_days REAL NOT NULL, earnings TEXT NOT NULL DEFAULT '[]', deductions TEXT NOT NULL DEFAULT '[]',
  employer TEXT NOT NULL DEFAULT '[]', gross REAL NOT NULL DEFAULT 0, total_deductions REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL DEFAULT 0, employer_cost REAL NOT NULL DEFAULT 0, withheld INTEGER NOT NULL DEFAULT 0,
  extra TEXT NOT NULL DEFAULT '{}', UNIQUE (pay_run_id, employee_id)
);
`;
