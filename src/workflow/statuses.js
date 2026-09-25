// Every status an order can be at, in the shared database's own words.
//
// Most are getmeds-system's (src/core/workflow/stateMachine.js). Four are this
// app's own and were added to the database by src/db/migrate.js: Team Leader's
// review, Sent back, Rejected and Packed. The Zoho-side stops (Sales Order being
// created, the invoice stages) are here because orders raised in getmeds-system,
// and orders Zoho moves along, can be at them.
//
// Until Sep 25, 2026 this app had its own names for three of them; the pages
// were changed to these: pending_approval → pending_management_approval,
// awaiting_payment → ready_for_finance_verified, picking → picking_packing.

const STATUS = {
  draft: 'Draft',
  pending_tl_approval: 'Waiting for Team Leader',
  pending_management_approval: 'Waiting for approval',
  returned: 'Sent back',
  rejected: 'Rejected',
  submitted: 'Submitted',
  validating: 'Checking',
  so_pending: 'Creating Sales Order',
  so_created: 'Sales Order created',
  ready_for_finance_verified: 'Awaiting payment',
  on_hold: 'On hold',
  exception: 'Exception',
  ready_for_draft_invoice: 'Ready to invoice',
  ready_for_invoice_sent: 'Invoice drafted',
  ready_for_dispatch: 'Ready for dispatch',
  picking_packing: 'Picking',
  packed: 'Packed',
  dispatched: 'Dispatched',
  tracking_shared: 'Tracking shared',
  completed: 'Completed',
  cancelled: 'Cancelled',
  deleted: 'Deleted',
};

// Every status but deleted.
const LIVE = Object.keys(STATUS).filter((s) => s !== 'deleted');
// Finished one way or another.
const CLOSED = ['completed', 'cancelled', 'rejected', 'deleted'];
// Before Finance has cleared it: what an owner may still cancel.
const BEFORE_PAYMENT = ['draft', 'pending_tl_approval', 'pending_management_approval', 'returned',
  'submitted', 'validating', 'so_pending', 'so_created', 'ready_for_finance_verified', 'on_hold'];
// Dispatch's part: from Finance's clearance until it's out.
const DISPATCH_QUEUE = ['ready_for_draft_invoice', 'ready_for_invoice_sent', 'ready_for_dispatch', 'picking_packing', 'packed'];

// Whose move it is, for "Next: Finance" on the page. Finished orders have none.
const WAITING_ON = {
  draft: 'salesperson',
  returned: 'salesperson',
  pending_tl_approval: 'team_leader',
  pending_management_approval: 'management',
  exception: 'management',
  ready_for_finance_verified: 'finance',
  on_hold: 'finance',
  ready_for_draft_invoice: 'dispatch',
  ready_for_invoice_sent: 'dispatch',
  ready_for_dispatch: 'dispatch',
  picking_packing: 'dispatch',
  packed: 'dispatch',
  dispatched: 'dispatch',
  tracking_shared: 'dispatch',
};

// The trail: each of this app's steps is saved as an order_events row whose
// event_type is getmeds-system's name for the same thing where there is one,
// so its timeline, notifications and reports read them too. metadata.step keeps
// this app's own step name.
const EVENT_TYPE_OF_STEP = {
  created: 'ORDER_CREATED',
  submit: 'ORDER_SUBMITTED',
  resubmit: 'ORDER_RESUBMITTED',
  tl_approve: 'TEAM_LEAD_ENDORSED',
  tl_send_back: 'TEAM_LEAD_SENT_BACK',
  tl_reject: 'TEAM_LEAD_REJECTED',
  approve: 'MANAGEMENT_APPROVED',
  send_back: 'MANAGEMENT_SENT_BACK',
  reject: 'MANAGEMENT_REJECTED',
  verify_payment: 'FINANCE_VERIFIED',
  hold: 'FINANCE_REJECTED',
  start_picking: 'PICKING_STARTED',
  mark_packed: 'ORDER_PACKED',
  dispatch: 'ORDER_DISPATCHED',
  deliver: 'DELIVERY_CONFIRMED',
  cancel: 'ORDER_CANCELLED',
  edit: 'ORDER_DETAILS_EDITED',
  delete_order: 'ORDER_DELETED',
  restore: 'ORDER_RESTORED',
};

// Reading back: which of this app's steps a trail row counts as, for the
// dashboards (approval rate, turnaround…). Rows getmeds-system wrote for the
// same things count too; everything else is shown but counts as nothing.
const STEP_OF_EVENT_TYPE = {
  ...Object.fromEntries(Object.entries(EVENT_TYPE_OF_STEP).map(([step, type]) => [type, step])),
  ZOHO_DELIVERED: 'deliver',
  ORDER_COMPLETED: 'completed',
};

// A plain label for a trail row nobody gave one (getmeds-system's own rows).
function labelOfEvent(eventType, row = {}) {
  const special = {
    STATUS_CHANGE: row.new_status ? `Moved to ${STATUS[row.new_status] || row.new_status}` : 'Status changed',
    ZOHO_SO_CONFIRMED: 'Sales Order confirmed in Zoho',
    ZOHO_SYNC_FAILED: 'Zoho sync failed',
    ZOHO_SYNC_RECOVERED: 'Zoho sync recovered',
    DISPATCH_HOLD: 'On hold by Dispatch',
    DISPATCH_HOLD_LIFTED: 'Dispatch hold lifted',
    TRACKING_ON_HOLD: 'Tracking number on hold',
    TRACKING_HOLD_RELEASED: 'Tracking hold lifted',
    DISPATCH_TRACKING_ADDED: 'Tracking number added',
    RX_REJECTED: 'Prescription rejected',
  };
  if (special[eventType]) return special[eventType];
  return String(eventType || 'Event').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
    .replace(/\bzoho\b/gi, 'Zoho').replace(/\bso\b/g, 'Sales Order').replace(/\brx\b/gi, 'Rx');
}

module.exports = {
  STATUS, LIVE, CLOSED, BEFORE_PAYMENT, DISPATCH_QUEUE, WAITING_ON,
  EVENT_TYPE_OF_STEP, STEP_OF_EVENT_TYPE, labelOfEvent,
};
