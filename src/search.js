// The search box at the top of every page: orders by number, customer, Zoho
// Sales Order number, receiver or phone; customers and products by name.
// Orders are limited to the ones this person may see (the same rule as the
// order lists, src/orderRepo.js), and include history imported from Zoho,
// which the lists leave out.
const express = require('express');
const db = require('./db');
const { requireUser } = require('./accounts');
const { visibilitySql } = require('./orderRepo');
const { STATUS } = require('./workflow/statuses');

const PER_KIND = 8;
const likeOf = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const router = express.Router();

router.get('/', requireUser, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ query: q, orders: [], customers: [], products: [] });
    const like = likeOf(q);
    const vis = visibilitySql(req.user);
    const [orders, customers, products] = await Promise.all([
      db.prepare(
        `SELECT o.getmeds_order_id, o.status, o.total_amount, o.zoho_so_number, o.created_at, c.name AS customer_name, u.name AS owner_name
           FROM orders o
           LEFT JOIN customers c ON c.id = o.customer_id
           LEFT JOIN users u ON u.id = o.medrep_id
          WHERE ${vis.sql}
            AND (o.getmeds_order_id ILIKE ? OR c.name ILIKE ? OR o.zoho_so_number ILIKE ?
                 OR o.intake_receiver ILIKE ? OR o.intake_contact_no ILIKE ? OR c.contact_number ILIKE ?)
          ORDER BY (o.getmeds_order_id ILIKE 'ZOHO-%'), o.created_at DESC
          LIMIT ${PER_KIND}`,
      ).all(...vis.params, like, like, like, like, like, like),
      db.prepare(
        `SELECT id, name, contact_number, address, zoho_contact_id FROM customers
          WHERE is_active = 1 AND (name ILIKE ? OR contact_number ILIKE ?)
          ORDER BY (zoho_contact_id IS NULL), name LIMIT ${PER_KIND}`,
      ).all(like, like),
      db.prepare(
        `SELECT id, name, sku, unit_price, stock FROM products
          WHERE is_active = 1 AND (name ILIKE ? OR sku ILIKE ?) ORDER BY name LIMIT ${PER_KIND}`,
      ).all(like, like),
    ]);
    res.json({
      query: q,
      orders: orders.map((o) => ({
        id: o.getmeds_order_id,
        status: o.status,
        statusLabel: STATUS[o.status] || o.status,
        customer: o.customer_name,
        owner: o.owner_name,
        total: Number(o.total_amount) || 0,
        zohoSo: o.zoho_so_number || null,
        createdAt: o.created_at,
        imported: String(o.getmeds_order_id).startsWith('ZOHO-'),
      })),
      customers: customers.map((c) => ({ id: c.id, name: c.name, contactNumber: c.contact_number, address: c.address, inZoho: Boolean(c.zoho_contact_id) })),
      products: products.map((p) => ({ id: p.id, name: p.name, sku: p.sku, price: p.unit_price, stock: p.stock })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
