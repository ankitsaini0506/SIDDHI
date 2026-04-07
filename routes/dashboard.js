require('dotenv').config();
const express     = require('express');
const { createClient } = require('@supabase/supabase-js');
const verifyToken = require('../middleware/auth');

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Helper — build date filter ISO string based on filter param
function getDateFilter(filter) {
  const now = new Date();
  if (filter === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }
  if (filter === 'weekly')  return new Date(now - 7  * 24 * 60 * 60 * 1000).toISOString();
  if (filter === 'monthly') return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  if (filter === 'yearly')  return new Date(now - 365* 24 * 60 * 60 * 1000).toISOString();
  // default: today
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

// ── GET /api/admin/dashboard  (protected) ─────────────────
router.get('/dashboard', verifyToken, async (req, res) => {
  try {
    const filter    = req.query.filter || 'today';
    const since     = getDateFilter(filter);
    const supabase  = getSupabase();

    // Fetch all orders in the period
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, status, total_amount, created_at, completed_at')
      .gte('created_at', since);

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    // Today's start for "today" sub-counts (always absolute, regardless of filter)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const total_orders    = orders.length;
    const pending_orders  = orders.filter(o => o.status === 'pending').length;
    const in_kitchen      = orders.filter(o => o.status === 'in_kitchen').length;

    const deliveredOrders = orders.filter(o => o.status === 'delivered');
    const total_revenue   = deliveredOrders.reduce((s, o) => s + (o.total_amount || 0), 0);
    const delivered_count = deliveredOrders.length;
    const avg_order_value = delivered_count > 0 ? Math.round(total_revenue / delivered_count) : 0;

    const delivered_today = orders.filter(o =>
      o.status === 'delivered' && new Date(o.completed_at || o.created_at) >= todayStart
    ).length;

    const cancelled_today = orders.filter(o =>
      o.status === 'cancelled' && new Date(o.created_at) >= todayStart
    ).length;

    res.json({
      success: true,
      message: 'Dashboard data fetched',
      data: {
        total_orders,
        total_revenue,
        pending_orders,
        in_kitchen,
        delivered_today,
        cancelled_today,
        avg_order_value,
        filter,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/admin/dashboard/orders-summary  (protected) ──
router.get('/dashboard/orders-summary', verifyToken, async (req, res) => {
  try {
    const filter   = req.query.filter || 'monthly';
    const since    = getDateFilter(filter);
    const supabase = getSupabase();

    const { data: orders, error } = await supabase
      .from('orders')
      .select('created_at, total_amount, status')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    // Group by date
    const grouped = {};
    for (const order of orders) {
      const date = order.created_at.split('T')[0];
      if (!grouped[date]) grouped[date] = { date, count: 0, revenue: 0 };
      grouped[date].count++;
      if (order.status === 'delivered') grouped[date].revenue += order.total_amount || 0;
    }

    res.json({
      success: true,
      message: 'Orders summary fetched',
      data: Object.values(grouped).sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/admin/dashboard/revenue  (protected) ─────────
router.get('/dashboard/revenue', verifyToken, async (req, res) => {
  try {
    const filter   = req.query.filter || 'yearly';
    const since    = getDateFilter(filter);
    const supabase = getSupabase();

    const { data: orders, error } = await supabase
      .from('orders')
      .select('created_at, total_amount, status')
      .eq('status', 'delivered')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const grouped = {};
    for (const order of orders) {
      const d     = new Date(order.created_at);
      const key   = `${d.getFullYear()}-${d.getMonth()}`;
      if (!grouped[key]) grouped[key] = { month: MONTHS[d.getMonth()], year: d.getFullYear(), revenue: 0 };
      grouped[key].revenue += order.total_amount || 0;
    }

    res.json({
      success: true,
      message: 'Revenue data fetched',
      data: Object.values(grouped),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/admin/dashboard/top-items  (protected) ───────
router.get('/dashboard/top-items', verifyToken, async (req, res) => {
  try {
    const limit    = parseInt(req.query.limit) || 10;
    const filter   = req.query.filter || 'monthly';
    const since    = getDateFilter(filter);
    const supabase = getSupabase();

    // Fetch order_items joined with orders (for date filter) and menu_items (for image)
    const { data: items, error } = await supabase
      .from('order_items')
      .select('item_name, item_price, quantity, menu_item_id, orders!inner(created_at, status)')
      .gte('orders.created_at', since);

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    // Group by item_name
    const grouped = {};
    for (const item of items || []) {
      const name = item.item_name;
      if (!grouped[name]) grouped[name] = { name, menu_item_id: item.menu_item_id, total_ordered: 0, total_revenue: 0 };
      grouped[name].total_ordered += item.quantity;
      grouped[name].total_revenue += item.item_price * item.quantity;
    }

    // Fetch image_urls for top items
    const topItems = Object.values(grouped)
      .sort((a, b) => b.total_ordered - a.total_ordered)
      .slice(0, limit);

    // Attach image_url from menu_items
    for (const item of topItems) {
      if (item.menu_item_id) {
        const { data: mi } = await supabase
          .from('menu_items')
          .select('image_url')
          .eq('id', item.menu_item_id)
          .maybeSingle();
        item.image_url = mi ? mi.image_url : null;
      }
      delete item.menu_item_id;
    }

    res.json({ success: true, message: 'Top items fetched', data: topItems });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/admin/dashboard/avg-order-value  (protected) ─
router.get('/dashboard/avg-order-value', verifyToken, async (req, res) => {
  try {
    const filter   = req.query.filter || 'weekly';
    const since    = getDateFilter(filter);
    const supabase = getSupabase();

    const { data: orders, error } = await supabase
      .from('orders')
      .select('total_amount')
      .eq('status', 'delivered')
      .gte('created_at', since);

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    const total   = (orders || []).reduce((s, o) => s + (o.total_amount || 0), 0);
    const count   = orders ? orders.length : 0;
    const avg     = count > 0 ? Math.round(total / count) : 0;

    res.json({
      success: true,
      message: 'Average order value fetched',
      data: { avg_order_value: avg, period: filter },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/admin/customers  (protected) ─────────────────
router.get('/customers', verifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const supabase  = getSupabase();

    const { data: orders, error } = await supabase
      .from('orders')
      .select('customer_name, customer_phone, total_amount, created_at')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    // Group by phone
    const customerMap = {};
    for (const o of orders) {
      const phone = o.customer_phone;
      if (!customerMap[phone]) {
        customerMap[phone] = {
          customer_name:   o.customer_name,
          customer_phone:  phone,
          total_orders:    0,
          total_spent:     0,
          last_order_date: o.created_at,
        };
      }
      customerMap[phone].total_orders++;
      customerMap[phone].total_spent += o.total_amount || 0;
      if (o.created_at > customerMap[phone].last_order_date)
        customerMap[phone].last_order_date = o.created_at;
    }

    let customers = Object.values(customerMap);

    // Status filter
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    if (status === 'active')
      customers = customers.filter(c => c.last_order_date >= thirtyDaysAgo);
    else if (status === 'inactive')
      customers = customers.filter(c => c.last_order_date < thirtyDaysAgo);

    // Pagination
    const offset    = (parseInt(page) - 1) * parseInt(limit);
    const paginated = customers.slice(offset, offset + parseInt(limit));

    res.json({ success: true, message: 'Customers fetched', data: paginated });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/admin/customers/:phone/orders  (protected) ───
router.get('/customers/:phone/orders', verifyToken, async (req, res) => {
  try {
    const { phone } = req.params;
    const supabase  = getSupabase();

    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('customer_phone', phone)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    res.json({ success: true, message: 'Customer orders fetched', data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PATCH /api/admin/customers/:phone/block  (protected) ──
router.patch('/customers/:phone/block', verifyToken, async (req, res) => {
  try {
    const { phone }  = req.params;
    const { reason } = req.body;
    const supabase   = getSupabase();

    // Fetch current restaurant row
    const { data: rest } = await supabase
      .from('restaurants')
      .select('id, operating_hours')
      .limit(1)
      .maybeSingle();

    if (!rest) return res.status(404).json({ success: false, message: 'Restaurant not found' });

    // Use operating_hours JSONB to also store blocked_phones (reuse existing JSONB)
    // Better: store in a dedicated key inside operating_hours
    const current = rest.operating_hours || {};
    const blocked  = current.blocked_phones || [];

    if (!blocked.includes(phone)) {
      blocked.push({ phone, reason: reason || 'Blocked by admin', blocked_at: new Date().toISOString() });
    }

    await supabase
      .from('restaurants')
      .update({ operating_hours: { ...current, blocked_phones: blocked } })
      .eq('id', rest.id);

    res.json({ success: true, message: 'Customer blocked' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/admin/payments  (protected) ──────────────────────
router.get('/payments', verifyToken, async (req, res) => {
  try {
    const { filter = 'today', status } = req.query;
    const supabase = getSupabase();

    // Date filter
    const now = new Date();
    let dateFilter;
    if (filter === 'today') {
      const s = new Date(now); s.setHours(0, 0, 0, 0);
      dateFilter = s.toISOString();
    } else if (filter === 'weekly') {
      dateFilter = new Date(now - 7  * 24 * 60 * 60 * 1000).toISOString();
    } else if (filter === 'monthly') {
      dateFilter = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    } else {
      // Default: start of current month
      dateFilter = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    }

    let query = supabase
      .from('orders')
      .select('*')
      .gte('created_at', dateFilter)
      .order('created_at', { ascending: false });

    if (status) query = query.eq('payment_status', status);

    const { data: orders, error } = await query;
    if (error) throw error;

    // Attach approved items to each order
    const ordersWithItems = await Promise.all(
      (orders || []).map(async (order) => {
        const { data: items } = await supabase
          .from('order_items')
          .select('item_name, approved_quantity, final_price, item_price, quantity')
          .eq('order_id', order.id)
          .gt('approved_quantity', 0);

        return {
          order_number:        order.order_number,
          customer_name:       order.customer_name,
          customer_phone:      order.customer_phone,
          order_type:          order.order_type,
          total_amount:        order.total_amount,
          payment_status:      order.payment_status,
          payment_method:      order.payment_method,
          razorpay_payment_id: order.razorpay_payment_id,
          paid_at:             order.paid_at,
          status:              order.status,
          items: (items || []).map(i => ({
            item_name:         i.item_name,
            approved_quantity: i.approved_quantity ?? i.quantity,
            final_price:       i.final_price,
            effective_price:   i.final_price ?? i.item_price,
            item_subtotal:     (i.approved_quantity ?? i.quantity) * (i.final_price ?? i.item_price),
          })),
        };
      })
    );

    const paidOrders     = (orders || []).filter(o => o.payment_status === 'paid');
    const failedOrders   = (orders || []).filter(o => o.payment_status === 'failed');
    const refundedOrders = (orders || []).filter(o => o.payment_status === 'refunded');
    const total_collected = paidOrders.reduce((s, o) => s + (o.total_amount || 0), 0);
    const paid_orders     = paidOrders.length;

    res.json({
      success: true,
      message: 'Payment dashboard fetched',
      data:    ordersWithItems,
      summary: {
        total_collected,
        paid_orders,
        failed_payments:  failedOrders.length,
        refunded:         refundedOrders.length,
        total_orders:     (orders || []).length,
        avg_order_value:  paid_orders > 0 ? Math.round(total_collected / paid_orders) : 0,
      },
      filter,
      period: filter,
    });
  } catch (err) {
    console.error('Admin payments error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

module.exports = router;
