// What happens in Zoho when this app's steps are taken. Each runs
// getmeds-system's own code for it (src/core), so an order goes to Zoho exactly
// the way it does from getmeds-system:
//
//   Approve         creates the Sales Order (as a Draft) and moves the order to
//                   Finance. A failed create doesn't stop the approval: the
//                   order carries on, marked failed, and the retry queue
//                   (zohoRetryService) tries again.
//   Verify payment  confirms that Sales Order, so Zoho can invoice and pack it.
//                   Zoho being down never undoes the verification; it is
//                   recorded on the order for someone to finish.
//
// All of it obeys getmeds-system's safety switches: ZOHO_MODE (mock unless
// set), ZOHO_DRY_RUN (nothing leaves this app), ZOHO_TEST_CUSTOMER_IDS (only
// those customers).
const db = require('../db');
const zoho = require('../core/integrations/zoho');
const ordersController = require('../core/controllers/orders.controller');
const { markVerifiedWithOrder } = require('../core/controllers/paymentProof.controller');
const { zohoWriteMode } = require('../core/services/zohoWriteGuard');
const { isDryRunMode } = require('../core/services/zohoTestFlags');
const { claimOrder, releaseClaim, describeClaim } = require('../core/services/orderClaimService');
const { logEvent } = require('../core/services/auditService');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// "First click wins" for a step that writes to Zoho: two managers pressing
// Approve at once must not make two Sales Orders. The loser is told who is
// already doing it.
async function withClaim(row, fromStatuses, label, fn) {
  const token = await claimOrder(row.id, fromStatuses, label);
  if (!token) {
    const now = await db.prepare('SELECT status, action_claim FROM orders WHERE id = ?').get(row.id);
    if (now && !fromStatuses.includes(now.status)) throw bad('Someone has just moved this order on. Reload it to see where it is now.', 409);
    throw bad(`${describeClaim(now?.action_claim) || 'Someone else'} is already doing this. Reload in a moment.`, 409);
  }
  try {
    return await fn();
  } finally {
    await releaseClaim(row.id, token);
  }
}

// Approve: the Sales Order is made now. The customer has to be a Zoho contact
// for that (a customer added here waits in Pending Customers until someone
// pushes or links it), so an approval for one that isn't is refused with what
// to do, rather than sent to fail in Zoho.
async function approveInZoho(row, actor, note) {
  if (!row.customer_zoho_contact_id && !isDryRunMode()) {
    throw bad(`${row.customer_name} isn't in Zoho yet, so there's no customer to put on the Sales Order. `
      + "Ask an admin to push or link them on getmeds-system's Pending Customers page, then approve.", 409);
  }
  return withClaim(row, ['pending_management_approval'], `Approve by ${actor.name}`, async () => {
    await logEvent({
      orderId: row.id,
      eventType: 'MANAGEMENT_APPROVED',
      oldStatus: row.status,
      newStatus: row.status,
      actorId: actor.id,
      actorName: actor.name,
      notes: note || 'Approved by Management — sending to Zoho.',
      metadata: { step: 'approve', label: 'Approved' },
    });
    const items = await db.prepare(
      `SELECT oi.*, COALESCE(oi.product_label, p.name) AS name, p.sku, p.zoho_item_id, p.unit
         FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ? ORDER BY oi.id`,
    ).all(row.id);
    // The Sales Order is the order owner's (their Zoho Salesperson), so the
    // pipeline's own trail entries are in their name, as in getmeds-system.
    return ordersController.syncOrderToZohoAndFinalize({
      order: row,
      items,
      getmedsOrderId: row.getmeds_order_id,
      pipelineActor: { id: row.medrep_id, name: row.medrep_name },
      notifyRecipientId: row.medrep_id,
    });
  });
}

// Verify payment: confirm the order's Sales Order in Zoho, and mark any proof
// of payment on the order verified with it. Called after the verification
// itself is saved. getmeds-system's finance.controller.js verifyAccount, the
// same three branches.
async function confirmInZoho(row, actor, newStatus) {
  await markVerifiedWithOrder(row.id, actor.id, new Date().toISOString());
  if (!row.zoho_so_id) return { ok: false, skipped: true, error: 'The order has no Sales Order in Zoho yet.' };

  const soLabel = row.zoho_so_number || row.zoho_so_id;
  const guard = zohoWriteMode(row.customer_zoho_contact_id);
  if (guard.mode === 'dry-run') {
    await db.prepare("UPDATE orders SET zoho_so_status = 'confirmed' WHERE id = ?").run(row.id);
    await logEvent({ orderId: row.id, eventType: 'ZOHO_SO_CONFIRMED', oldStatus: newStatus, newStatus, actorId: actor.id, actorName: actor.name,
      notes: `Sales Order ${soLabel} treated as confirmed — dry run, Zoho not contacted.`, metadata: { zohoSalesOrderId: row.zoho_so_id, dryRun: true } });
    return { ok: true, dryRun: true };
  }
  if (guard.mode === 'blocked') {
    await logEvent({ orderId: row.id, eventType: 'ZOHO_SYNC_SKIPPED', oldStatus: newStatus, newStatus, actorId: actor.id, actorName: actor.name,
      notes: `Verified here; the Sales Order was not confirmed in Zoho — ${guard.message}`, metadata: { zohoSalesOrderId: row.zoho_so_id, reason: guard.code } });
    return { ok: false, skipped: true, error: guard.message };
  }
  try {
    const result = await zoho.confirmSalesOrder(row.zoho_so_id);
    await db.prepare("UPDATE orders SET zoho_so_status = 'confirmed' WHERE id = ?").run(row.id);
    await logEvent({ orderId: row.id, eventType: 'ZOHO_SO_CONFIRMED', oldStatus: newStatus, newStatus, actorId: actor.id, actorName: actor.name,
      notes: result?.alreadyConfirmed ? `Sales Order ${soLabel} was already confirmed in Zoho.` : `Sales Order ${soLabel} confirmed in Zoho by this verification.`,
      metadata: { zohoSalesOrderId: row.zoho_so_id, alreadyConfirmed: Boolean(result?.alreadyConfirmed) } });
    return { ok: true, alreadyConfirmed: Boolean(result?.alreadyConfirmed) };
  } catch (err) {
    await db.prepare("UPDATE orders SET zoho_sync_status = 'failed' WHERE id = ?").run(row.id);
    await logEvent({ orderId: row.id, eventType: 'ZOHO_SYNC_FAILED', oldStatus: newStatus, newStatus, actorId: actor.id, actorName: actor.name,
      notes: `Verified here, but the Sales Order could not be confirmed in Zoho: ${err.message} Confirm it in Zoho Books.`,
      metadata: { zohoSalesOrderId: row.zoho_so_id, error: err.message } });
    console.error('[verify_payment] Zoho confirm failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// True when a cancelled or purged order leaves a real Sales Order behind in
// Zoho that someone has to void there (this app never deletes in Zoho).
const hasRealSalesOrder = (row) => Boolean(row.zoho_so_id) && !String(row.zoho_so_id).startsWith('DRYRUN');

module.exports = { approveInZoho, confirmInZoho, withClaim, hasRealSalesOrder };
