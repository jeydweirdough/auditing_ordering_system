'use strict';

const assert = require('node:assert');
const http = require('node:http');
const app = require('../src/server');

async function run() {
  console.log('===============================================================');
  console.log('📦 Testing Dispatch Proof Attachments & Tracking Flow');
  console.log('===============================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const login = async (email, password = 'passwordpass') => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.strictEqual(res.status, 200, `Login failed for ${email}`);
    const rawCookie = res.headers.get('set-cookie');
    return rawCookie ? rawCookie.split(';')[0] : '';
  };

  try {
    const salesCookie = await login('salesperson.test@getmeds.ph');
    const tlCookie = await login('teamleader.test@getmeds.ph');
    const mgmtCookie = await login('management.test@getmeds.ph');
    const finCookie = await login('finance.test@getmeds.ph');
    const dispatchCookie = await login('dispatch.test@getmeds.ph');

    // 1. Create order
    console.log('[STEP 1] Salesperson creates order...');
    const createRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: salesCookie },
      body: JSON.stringify({
        customerName: 'General Hospital Dispatch Test',
        contactNumber: '0918-123-4567',
        address: '123 Hospital Blvd, Quezon City',
        division: 'HOS',
        subDivision: 'Hospital',
        headQuarter: 'QC Central HQ',
        invoicingFrom: '2mg Incorporated',
        paymentMethod: 'Bank transfer',
        source: 'Hospital PO',
        paymentTerms: '30 days',
        deliveryMethod: 'Grab Express',
        remarks: 'Order for testing dispatch proof flow',
        items: [
          { product: 'AtraGet 10mg', qty: 5, unitPrice: 250, priceType: 'hospital' },
        ],
      }),
    });
    const createData = await createRes.json();
    assert([200, 201, 202].includes(createRes.status), 'Failed to create order');
    const orderId = createData.order.id;
    console.log(`✓ Order created: ${orderId}, status: ${createData.order.status}`);

    // 2. Team Leader approves
    console.log('[STEP 2] Team Leader approves...');
    const tlApproveRes = await fetch(`${baseUrl}/api/orders/${orderId}/actions/tl_approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: tlCookie },
      body: JSON.stringify({ note: 'Looks good to TL' }),
    });
    const tlData = await tlApproveRes.json();
    assert([200, 202].includes(tlApproveRes.status));
    assert.strictEqual(tlData.order.status, 'pending_approval');
    console.log(`✓ TL approved, status: ${tlData.order.status}`);

    // 3. Management approves -> awaiting_payment
    console.log('[STEP 3] Management approves...');
    const mgmtApproveRes = await fetch(`${baseUrl}/api/orders/${orderId}/actions/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: mgmtCookie },
      body: JSON.stringify({ note: 'Management approved' }),
    });
    const mgmtData = await mgmtApproveRes.json();
    assert([200, 202].includes(mgmtApproveRes.status));
    assert.strictEqual(mgmtData.order.status, 'awaiting_payment');
    console.log(`✓ Management approved, status: ${mgmtData.order.status}`);

    // 4. Finance verifies payment -> ready_for_dispatch
    console.log('[STEP 4] Finance verifies payment...');
    const finApproveRes = await fetch(`${baseUrl}/api/orders/${orderId}/actions/verify_payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: finCookie },
      body: JSON.stringify({
        method: 'Bank transfer',
        reference: 'BDO-TRX-882910',
        amount: 1250,
        paidOn: '2026-09-15',
      }),
    });
    const finData = await finApproveRes.json();
    assert([200, 202].includes(finApproveRes.status));
    assert.strictEqual(finData.order.status, 'ready_for_dispatch');
    console.log(`✓ Finance verified payment, status: ${finData.order.status}`);

    // 5. Dispatch starts picking
    console.log('[STEP 5] Dispatch starts picking...');
    const pickRes = await fetch(`${baseUrl}/api/orders/${orderId}/actions/start_picking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: dispatchCookie },
      body: JSON.stringify({ note: 'Picker assigned' }),
    });
    const pickData = await pickRes.json();
    assert([200, 202].includes(pickRes.status));
    assert.strictEqual(pickData.order.status, 'picking');
    console.log(`✓ Picking started, status: ${pickData.order.status}`);

    // 6. Dispatch marks packed with packing_proof attachment and notes
    console.log('[STEP 6] Dispatch marks packed with packing proof attachment & notes...');
    const packImgB64 = Buffer.from('FAKE_PACKING_IMAGE_DATA_BYTES').toString('base64');
    const packRes = await fetch(`${baseUrl}/api/orders/${orderId}/actions/mark_packed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: dispatchCookie },
      body: JSON.stringify({
        packingNotes: 'Double boxed, bubble wrap verified, tamper seal #9921',
        attachments: [
          {
            name: 'packed_box_sealed.jpg',
            kind: 'packing_proof',
            data: packImgB64,
          },
        ],
      }),
    });
    const packData = await packRes.json();
    assert([200, 202].includes(packRes.status), 'Mark packed failed: ' + JSON.stringify(packData));
    assert.strictEqual(packData.order.status, 'packed');
    assert.strictEqual(packData.order.shipment.packingNotes, 'Double boxed, bubble wrap verified, tamper seal #9921');
    assert(packData.order.shipment.packedAt, 'shipment.packedAt must be set');
    assert(packData.order.shipment.packedBy, 'shipment.packedBy must be set');

    const packingAttachment = packData.order.attachments.find((a) => a.kind === 'packing_proof');
    assert(packingAttachment, 'packing_proof attachment must be present in order.attachments');
    assert.strictEqual(packingAttachment.name, 'packed_box_sealed.jpg');
    console.log(`✓ Order packed! Attachment: ${packingAttachment.name}, packedBy: ${packData.order.shipment.packedBy}`);

    // 7. Dispatch dispatches with courier, tracking URL / ref id, and dispatch_proof attachment
    console.log('[STEP 7] Dispatch dispatches order with tracking URL & waybill photo...');
    const waybillImgB64 = Buffer.from('FAKE_WAYBILL_RECEIPT_BYTES').toString('base64');
    const trackingUrl = 'https://track.lbcexpress.com/track/LBC-PH-9948201';
    const dispatchRes = await fetch(`${baseUrl}/api/orders/${orderId}/actions/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: dispatchCookie },
      body: JSON.stringify({
        courier: 'LBC Express',
        trackingNumber: trackingUrl,
        attachments: [
          {
            name: 'waybill_receipt.png',
            kind: 'dispatch_proof',
            data: waybillImgB64,
          },
        ],
      }),
    });
    const dispatchData = await dispatchRes.json();
    assert([200, 202].includes(dispatchRes.status), 'Dispatch failed: ' + JSON.stringify(dispatchData));
    assert.strictEqual(dispatchData.order.status, 'dispatched');
    assert.strictEqual(dispatchData.order.shipment.courier, 'LBC Express');
    assert.strictEqual(dispatchData.order.shipment.trackingNumber, trackingUrl);
    assert(dispatchData.order.shipment.dispatchedAt, 'shipment.dispatchedAt must be set');
    assert(dispatchData.order.shipment.dispatchedBy, 'shipment.dispatchedBy must be set');

    const dispatchAttachment = dispatchData.order.attachments.find((a) => a.kind === 'dispatch_proof');
    assert(dispatchAttachment, 'dispatch_proof attachment must be present in order.attachments');
    assert.strictEqual(dispatchAttachment.name, 'waybill_receipt.png');
    console.log(`✓ Order dispatched! Courier: ${dispatchData.order.shipment.courier}, Tracking: ${dispatchData.order.shipment.trackingNumber}, Proof: ${dispatchAttachment.name}`);

    // 8. Deliver with receivedBy and delivery_proof (POD) attachment
    console.log('[STEP 8] Mark delivered with recipient & POD photo...');
    const podImgB64 = Buffer.from('FAKE_POD_RECEIPT_SIGNATURE_BYTES').toString('base64');
    const deliverRes = await fetch(`${baseUrl}/api/orders/${orderId}/actions/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: dispatchCookie },
      body: JSON.stringify({
        receivedBy: 'Head Nurse Elena Ramos',
        attachments: [
          {
            name: 'pod_signature_received.jpg',
            kind: 'delivery_proof',
            data: podImgB64,
          },
        ],
      }),
    });
    const deliverData = await deliverRes.json();
    assert([200, 202].includes(deliverRes.status), 'Deliver failed: ' + JSON.stringify(deliverData));
    assert.strictEqual(deliverData.order.status, 'completed');
    assert.strictEqual(deliverData.order.shipment.receivedBy, 'Head Nurse Elena Ramos');
    assert(deliverData.order.shipment.deliveredAt, 'shipment.deliveredAt must be set');
    assert(deliverData.order.shipment.deliveredBy, 'shipment.deliveredBy must be set');

    const podAttachment = deliverData.order.attachments.find((a) => a.kind === 'delivery_proof');
    assert(podAttachment, 'delivery_proof attachment must be present in order.attachments');
    assert.strictEqual(podAttachment.name, 'pod_signature_received.jpg');
    console.log(`✓ Order completed! Recipient: ${deliverData.order.shipment.receivedBy}, DeliveredBy: ${deliverData.order.shipment.deliveredBy}, POD: ${podAttachment.name}`);

    // 9. Fetch order details to ensure all shipment facts and proof files persist
    console.log('[STEP 9] Fetch GET /api/orders/:id and verify all proof files...');
    const getRes = await fetch(`${baseUrl}/api/orders/${orderId}`, {
      headers: { Cookie: dispatchCookie },
    });
    assert.strictEqual(getRes.status, 200);
    const fetched = await getRes.json();
    const o = fetched.order;

    assert.strictEqual(o.status, 'completed');
    assert.strictEqual(o.shipment.courier, 'LBC Express');
    assert.strictEqual(o.shipment.trackingNumber, trackingUrl);
    assert.strictEqual(o.shipment.packingNotes, 'Double boxed, bubble wrap verified, tamper seal #9921');
    assert.strictEqual(o.shipment.receivedBy, 'Head Nurse Elena Ramos');

    const proofKinds = o.attachments.map((a) => a.kind);
    assert(proofKinds.includes('packing_proof'), 'Expected packing_proof in attachments');
    assert(proofKinds.includes('dispatch_proof'), 'Expected dispatch_proof in attachments');
    assert(proofKinds.includes('delivery_proof'), 'Expected delivery_proof in attachments');

    console.log(`✓ Verification complete: Order ${o.id} has all 3 shipment proofs stored and rendered correctly.`);

    console.log('\n===============================================================');
    console.log('🎉 DISPATCH PROOF & ATTACHMENTS TEST PASSED 100%!');
    console.log('===============================================================');
    process.exit(0);
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
