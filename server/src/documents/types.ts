import type { PermModule } from '../auth.js';
import type { LockModule } from '../settings.js';

export interface DocTypeDef {
  type: string;
  label: string;
  plural: string;
  module: PermModule;
  lock: LockModule;
  party: 'customer' | 'vendor' | null;
  partyRequired: boolean;
  /** Lines carry prices and GST. */
  priced: boolean;
  side: 'sales' | 'purchase' | 'none';
  /** Status a document gets when it is submitted (saved as non-draft). */
  activeStatus: string;
  /** Statuses in which the document affects stock and/or the ledger. */
  posted: string[];
  statuses: Record<string, string>;
  approvable: boolean;
  /** Allowed parent document types for conversion. */
  from: string[];
  dueDate?: boolean;
  lineAccount?: boolean;
  warehouse?: boolean;
  description: string;
}

const S = (o: Record<string, string>) => o;

export const DOC_TYPES: Record<string, DocTypeDef> = {
  quote: {
    type: 'quote', label: 'Quote', plural: 'Quotes', module: 'sales', lock: 'sales', party: 'customer', partyRequired: true,
    priced: true, side: 'sales', activeStatus: 'sent', posted: [], approvable: true, from: [], dueDate: true,
    statuses: S({ draft: 'Draft', pending_approval: 'Pending Approval', sent: 'Sent', accepted: 'Accepted', declined: 'Declined', invoiced: 'Invoiced', expired: 'Expired' }),
    description: 'Estimates sent to customers before a sale',
  },
  sales_order: {
    type: 'sales_order', label: 'Sales Order', plural: 'Sales Orders', module: 'sales', lock: 'sales', party: 'customer', partyRequired: true,
    priced: true, side: 'sales', activeStatus: 'confirmed', posted: [], approvable: true, from: ['quote'], dueDate: true, warehouse: true,
    statuses: S({ draft: 'Draft', pending_approval: 'Pending Approval', confirmed: 'Confirmed', closed: 'Closed', void: 'Void' }),
    description: 'Confirmed customer orders that drive packing, shipping, invoicing and production',
  },
  package: {
    type: 'package', label: 'Package', plural: 'Packages', module: 'inventory', lock: 'inventory', party: 'customer', partyRequired: true,
    priced: false, side: 'none', activeStatus: 'packed', posted: ['shipped', 'delivered'], approvable: false, from: ['sales_order'], warehouse: true,
    statuses: S({ packed: 'Not Shipped', shipped: 'Shipped', delivered: 'Delivered' }),
    description: 'Packed goods against sales orders; physical stock leaves the warehouse when shipped',
  },
  invoice: {
    type: 'invoice', label: 'Invoice', plural: 'Invoices', module: 'sales', lock: 'sales', party: 'customer', partyRequired: true,
    priced: true, side: 'sales', activeStatus: 'open', posted: ['open', 'partially_paid', 'paid'], approvable: true,
    from: ['quote', 'sales_order', 'delivery_challan'], dueDate: true, warehouse: true, lineAccount: true,
    statuses: S({ draft: 'Draft', pending_approval: 'Pending Approval', open: 'Unpaid', partially_paid: 'Partially Paid', paid: 'Paid', void: 'Void' }),
    description: 'Tax invoices (GST rule 46) with e-invoicing and e-way bills',
  },
  credit_note: {
    type: 'credit_note', label: 'Credit Note', plural: 'Credit Notes', module: 'sales', lock: 'sales', party: 'customer', partyRequired: true,
    priced: true, side: 'sales', activeStatus: 'open', posted: ['open', 'closed'], approvable: true, from: ['invoice', 'sales_return'], warehouse: true, lineAccount: true,
    statuses: S({ draft: 'Draft', pending_approval: 'Pending Approval', open: 'Open', closed: 'Closed', void: 'Void' }),
    description: 'Reduce what a customer owes for returns, discounts or overbilling',
  },
  sales_return: {
    type: 'sales_return', label: 'Sales Return', plural: 'Sales Returns', module: 'sales', lock: 'inventory', party: 'customer', partyRequired: true,
    priced: false, side: 'none', activeStatus: 'approved', posted: ['received', 'credited'], approvable: false, from: ['sales_order', 'invoice'], warehouse: true,
    statuses: S({ approved: 'Approved', received: 'Received', credited: 'Credited', void: 'Void' }),
    description: 'Goods returned by customers (RMA); stock comes back in when received',
  },
  delivery_challan: {
    type: 'delivery_challan', label: 'Delivery Challan', plural: 'Delivery Challans', module: 'sales', lock: 'inventory', party: 'customer', partyRequired: true,
    priced: true, side: 'sales', activeStatus: 'open', posted: ['open', 'delivered', 'invoiced'], approvable: false, from: ['sales_order'], warehouse: true,
    statuses: S({ draft: 'Draft', open: 'Open', delivered: 'Delivered', invoiced: 'Invoiced', returned: 'Returned' }),
    description: 'Move goods without a sale: job work, supply on approval, branch transfer',
  },
  retainer_invoice: {
    type: 'retainer_invoice', label: 'Retainer Invoice', plural: 'Retainer Invoices', module: 'sales', lock: 'sales', party: 'customer', partyRequired: true,
    priced: false, side: 'sales', activeStatus: 'open', posted: [], approvable: false, from: ['quote'], lineAccount: false,
    statuses: S({ draft: 'Draft', open: 'Unpaid', paid: 'Paid', void: 'Void' }),
    description: 'Collect advances that are later applied to invoices',
  },
  purchase_request: {
    type: 'purchase_request', label: 'Purchase Request', plural: 'Purchase Requests', module: 'purchases', lock: 'purchases', party: null, partyRequired: false,
    priced: false, side: 'none', activeStatus: 'approved', posted: [], approvable: true, from: [],
    statuses: S({ draft: 'Draft', pending_approval: 'Pending Approval', approved: 'Approved', rejected: 'Rejected', ordered: 'Ordered', closed: 'Closed' }),
    description: 'Internal requests for goods or services before a vendor is chosen',
  },
  rfq: {
    type: 'rfq', label: 'Request for Quote', plural: 'Requests for Quote', module: 'purchases', lock: 'purchases', party: null, partyRequired: false,
    priced: false, side: 'none', activeStatus: 'open', posted: [], approvable: false, from: ['purchase_request'], dueDate: true,
    statuses: S({ draft: 'Draft', open: 'Open for Bids', closed: 'Bidding Closed', awarded: 'Awarded', ordered: 'Ordered', cancelled: 'Cancelled' }),
    description: 'Invite vendors to bid, compare bids and award line by line',
  },
  purchase_order: {
    type: 'purchase_order', label: 'Purchase Order', plural: 'Purchase Orders', module: 'purchases', lock: 'purchases', party: 'vendor', partyRequired: true,
    priced: true, side: 'purchase', activeStatus: 'issued', posted: [], approvable: true, from: ['purchase_request', 'rfq', 'sales_order'], dueDate: true, warehouse: true, lineAccount: true,
    statuses: S({ draft: 'Draft', pending_approval: 'Pending Approval', issued: 'Issued', closed: 'Closed', cancelled: 'Cancelled' }),
    description: 'Orders placed with vendors; tracked through receives and bills',
  },
  purchase_receive: {
    type: 'purchase_receive', label: 'Purchase Receive', plural: 'Purchase Receives', module: 'inventory', lock: 'inventory', party: 'vendor', partyRequired: true,
    priced: false, side: 'none', activeStatus: 'received', posted: ['received'], approvable: false, from: ['purchase_order'], warehouse: true,
    statuses: S({ pending_inspection: 'Pending Inspection', received: 'Received' }),
    description: 'Goods received notes (GRN) with optional quality inspection',
  },
  bill: {
    type: 'bill', label: 'Bill', plural: 'Bills', module: 'purchases', lock: 'purchases', party: 'vendor', partyRequired: true,
    priced: true, side: 'purchase', activeStatus: 'open', posted: ['open', 'partially_paid', 'paid'], approvable: true, from: ['purchase_order', 'purchase_receive'], dueDate: true, warehouse: true, lineAccount: true,
    statuses: S({ draft: 'Draft', pending_approval: 'Pending Approval', open: 'Open', partially_paid: 'Partially Paid', paid: 'Paid', void: 'Void' }),
    description: 'Vendor invoices with ITC, reverse charge, TDS and landed costs',
  },
  vendor_credit: {
    type: 'vendor_credit', label: 'Vendor Credit', plural: 'Vendor Credits', module: 'purchases', lock: 'purchases', party: 'vendor', partyRequired: true,
    priced: true, side: 'purchase', activeStatus: 'open', posted: ['open', 'closed'], approvable: true, from: ['bill'], warehouse: true, lineAccount: true,
    statuses: S({ draft: 'Draft', pending_approval: 'Pending Approval', open: 'Open', closed: 'Closed', void: 'Void' }),
    description: 'Debit notes for goods returned to vendors or price corrections',
  },
  expense: {
    type: 'expense', label: 'Expense', plural: 'Expenses', module: 'purchases', lock: 'purchases', party: 'vendor', partyRequired: false,
    priced: true, side: 'purchase', activeStatus: 'recorded', posted: ['recorded'], approvable: true, from: [], lineAccount: true,
    statuses: S({ draft: 'Draft', pending_approval: 'Pending Approval', recorded: 'Recorded', void: 'Void' }),
    description: 'Direct expenses paid from a bank, cash or card account',
  },
  transfer_order: {
    type: 'transfer_order', label: 'Transfer Order', plural: 'Transfer Orders', module: 'inventory', lock: 'inventory', party: null, partyRequired: false,
    priced: false, side: 'none', activeStatus: 'in_transit', posted: ['in_transit', 'transferred'], approvable: true, from: [], warehouse: true,
    statuses: S({ draft: 'Draft', pending_approval: 'Pending Approval', in_transit: 'In Transit', transferred: 'Transferred' }),
    description: 'Move stock between warehouses',
  },
  inventory_adjustment: {
    type: 'inventory_adjustment', label: 'Inventory Adjustment', plural: 'Inventory Adjustments', module: 'inventory', lock: 'inventory', party: null, partyRequired: false,
    priced: false, side: 'none', activeStatus: 'adjusted', posted: ['adjusted'], approvable: true, from: ['stock_count'], warehouse: true,
    statuses: S({ draft: 'Draft', pending_approval: 'Pending Approval', adjusted: 'Adjusted' }),
    description: 'Correct stock quantity or value for damage, theft or revaluation',
  },
  stock_count: {
    type: 'stock_count', label: 'Stock Count', plural: 'Stock Counts', module: 'inventory', lock: 'inventory', party: null, partyRequired: false,
    priced: false, side: 'none', activeStatus: 'in_progress', posted: [], approvable: false, from: [], warehouse: true,
    statuses: S({ draft: 'Draft', in_progress: 'In Progress', completed: 'Completed', cancelled: 'Cancelled' }),
    description: 'Cycle counts that reconcile physical stock and post adjustments',
  },
};

export const docType = (type: string): DocTypeDef => {
  const t = DOC_TYPES[type];
  if (!t) throw Object.assign(new Error(`Unknown document type '${type}'`), { status: 404 });
  return t;
};
