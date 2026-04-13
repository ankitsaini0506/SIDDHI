require('dotenv').config();
const express     = require('express');
const { createClient } = require('@supabase/supabase-js');
const verifyToken = require('../middleware/auth');
const { sendOrderAccepted, sendOrderRejected } = require('../utils/whatsapp');
const { initiateRefund } = require('../utils/razorpay');

const { events: wsEvents } = require('../utils/websocket');

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Helper — fetch full order with items
async function fetchOrderWithItems(supabase, id) {
  const { data: order, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error || !order) return { order: null, error };

  const { data: items } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', id);

  return { order: { ...order, items: items || [] }, error: null };
}

// Helper — recalculate coupon discount against a new subtotal
async function recalcCoupon(supabase, couponCode, newSubtotal) {
  if (!couponCode) return 0;
  const { data: coupon } = await supabase
    .from('coupons')
    .select('*')
    .eq('code', couponCode)
    .eq('is_active', true)
    .maybeSingle();
  if (!coupon) return 0;
  if (newSubtotal < (coupon.min_order_amount || 0)) return 0;

  if (coupon.discount_type === 'percentage') {
    const disc = Math.round(newSubtotal * coupon.discount_value / 100);
    return coupon.max_discount_amount ? Math.min(disc, coupon.max_discount_amount) : disc;
  }
  return coupon.discount_value || 0;
}

// ── GET /api/admin/orders/pending-count  (protected) ──────────
router.get('/pending-count', verifyToken, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { count, error } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .in('status', ['pending', 'requested']);

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    res.json({ success: true, message: 'Pending count fetched', data: { count: count || 0 } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/admin/orders/auto-cancel  (protected) ───────────
router.post('/auto-cancel', verifyToken, async (req, res) => {
  try {
    const supabase     = getSupabase();
    const fiveMinsAgo  = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { data: orders, error: fetchErr } = await supabase
      .from('orders')
      .select('id')
      .eq('status', 'pending')
      .lt('created_at', fiveMinsAgo);

    if (fetchErr) return res.status(500).json({ success: false, message: 'DB error', error: fetchErr.message });

    if (!orders || orders.length === 0)
      return res.json({ success: true, message: 'No orders to cancel', data: { cancelled_count: 0 } });

    const ids = orders.map(o => o.id);
    await supabase
      .from('orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .in('id', ids);

    res.json({ success: true, message: `${orders.length} orders auto-cancelled`, data: { cancelled_count: orders.length } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/admin/orders  (protected) ────────────────────────
router.get('/', verifyToken, async (req, res) => {
  try {
    const { status, type, filter, page = 1, limit = 20 } = req.query;
    const supabase = getSupabase();

    let query = supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);
    if (type)   query = query.eq('order_type', type);

    if (filter === 'today') {
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      query = query.gte('created_at', startOfDay.toISOString());
    } else if (filter === 'weekly') {
      query = query.gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
    } else if (filter === 'monthly') {
      query = query.gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    query = query.range(offset, offset + parseInt(limit) - 1);

    const { data: orders, error } = await query;
    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    const ordersWithItems = await Promise.all(
      orders.map(async (order) => {
        const { data: items } = await supabase
          .from('order_items')
          .select('*')
          .eq('order_id', order.id);

        // Resolve table info if table_id present
        let tableInfo = null;
        if (order.table_id) {
          const { data: tableRow } = await supabase
            .from('tables')
            .select('id, table_number, location, capacity')
            .eq('table_number', order.table_id)
            .maybeSingle();
          if (tableRow) {
            tableInfo = {
              table_uuid:     tableRow.id,
              table_number:   tableRow.table_number,
              location:       tableRow.location,
              capacity:       tableRow.capacity,
            };
          }
        }

        return {
          ...order,
          table_number: order.table_id,   // alias for clarity — same value as table_id integer
          table_info:   tableInfo,         // full table details (null if no table)
          items:        items || [],
        };
      })
    );

    res.json({ success: true, message: 'Orders fetched', data: ordersWithItems });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PATCH /api/admin/orders/:id/approve-items  (protected) ────
// Must be before other /:id routes
router.patch('/:id/approve-items', verifyToken, async (req, res) => {
  try {
    const { id }    = req.params;
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ success: false, message: 'items array is required' });

    const supabase = getSupabase();

    // Fetch order
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (orderErr || !order)
      return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.payment_status === 'paid')
      return res.status(400).json({ success: false, message: 'Order already paid, cannot modify items' });

    if (!['requested', 'payment_pending'].includes(order.status))
      return res.status(400).json({
        success: false,
        message: `Cannot modify order at this stage. Status: ${order.status}`,
      });

    // Validate each item
    for (const item of items) {
      if (item.approved_quantity < 0)
        return res.status(400).json({ success: false, message: 'Quantity cannot be negative' });

      const { data: dbItem } = await supabase
        .from('order_items')
        .select('requested_quantity, item_name')
        .eq('id', item.order_item_id)
        .maybeSingle();

      if (!dbItem)
        return res.status(400).json({ success: false, message: `Order item not found: ${item.order_item_id}` });

      if (dbItem.requested_quantity !== null && item.approved_quantity > dbItem.requested_quantity)
        return res.status(400).json({
          success: false,
          message: `Cannot approve more than requested for ${dbItem.item_name} (requested: ${dbItem.requested_quantity})`,
        });

      if (item.final_price !== null && item.final_price !== undefined && item.final_price <= 0)
        return res.status(400).json({ success: false, message: 'Price must be positive' });
    }

    // Track which items are being removed (for response)
    const removedItems = [];

    // Process each item
    for (const item of items) {
      if (item.approved_quantity === 0) {
        // Fetch name before deleting (for response)
        const { data: dbItem } = await supabase
          .from('order_items')
          .select('item_name, menu_item_id')
          .eq('id', item.order_item_id)
          .maybeSingle();

        await supabase
          .from('order_items')
          .delete()
          .eq('id', item.order_item_id);

        removedItems.push({
          item_name:  dbItem ? dbItem.item_name : 'Unknown',
          admin_note: item.admin_note || null,
        });
      } else {
        await supabase
          .from('order_items')
          .update({
            approved_quantity: item.approved_quantity,
            final_price:       item.final_price ?? null,
            admin_note:        item.admin_note || null,
            quantity:          item.approved_quantity,
          })
          .eq('id', item.order_item_id);
      }
    }

    // Fetch remaining items after processing
    const { data: remaining } = await supabase
      .from('order_items')
      .select('*')
      .eq('order_id', id);

    // All items deleted → reject order
    if (!remaining || remaining.length === 0) {
      await supabase
        .from('orders')
        .update({ status: 'rejected', updated_at: new Date().toISOString() })
        .eq('id', id);

      return res.json({
        success: true,
        message: 'All items out of stock. Order has been rejected.',
        data: {
          order_id: id,
          status:   'rejected',
          message:  'All items out of stock. Order has been rejected.',
        },
      });
    }

    // Recalculate subtotal from approved items
    const newSubtotal = remaining.reduce((s, i) => {
      const qty   = i.approved_quantity ?? i.quantity;
      const price = i.final_price ?? i.item_price;
      return s + (qty * price);
    }, 0);

    // Recalculate discount
    const newDiscount = await recalcCoupon(supabase, order.coupon_code, newSubtotal);
    const newTotal    = newSubtotal - newDiscount;

    // Update order
    await supabase
      .from('orders')
      .update({
        status:          'payment_pending',
        subtotal:        newSubtotal,
        discount_amount: newDiscount,
        total_amount:    newTotal,
        updated_at:      new Date().toISOString(),
      })
      .eq('id', id);

    // Build approved items response
    const approvedItems = remaining.map(i => ({
      item_name:          i.item_name,
      requested_quantity: i.requested_quantity,
      approved_quantity:  i.approved_quantity ?? i.quantity,
      final_price:        i.final_price,
      effective_price:    i.final_price ?? i.item_price,
      item_subtotal:      (i.approved_quantity ?? i.quantity) * (i.final_price ?? i.item_price),
      admin_note:         i.admin_note,
    }));

    const approveResponse = {
      order_id:       id,
      order_number:   order.order_number,
      status:         'payment_pending',
      approved_count: approvedItems.length,
      removed_count:  removedItems.length,
      approved_items: approvedItems,
      removed_items:  removedItems,
      new_subtotal:   newSubtotal,
      new_discount:   newDiscount,
      new_total:      newTotal,
      can_edit_again: true,
      note:           'Customer will see updated order and can now pay',
    };
    wsEvents.orderApproved(approveResponse);

    res.json({ success: true, message: 'Items approved. Customer can now pay.', data: approveResponse });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PATCH /api/admin/orders/:id/accept  (protected) ───────────
router.patch('/:id/accept', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { estimated_time_mins } = req.body;
    const supabase = getSupabase();

    const { order, error: fetchErr } = await fetchOrderWithItems(supabase, id);
    if (fetchErr || !order)
      return res.status(404).json({ success: false, message: 'Order not found' });

    const { data: updated, error } = await supabase
      .from('orders')
      .update({
        status:               'confirmed',
        estimated_time_mins:  estimated_time_mins ? parseInt(estimated_time_mins) : 30,
        updated_at:           new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, status, estimated_time_mins')
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Update failed', error: error.message });

    const waSid = await sendOrderAccepted(
      order.customer_phone, order.customer_name,
      order.order_number, estimated_time_mins || 30
    );

    await supabase.from('notification_logs').insert({
      order_id: id, type: 'order_accepted', phone: order.customer_phone,
      message:  `Order #${order.order_number} accepted, est. ${estimated_time_mins || 30} mins`,
      status:   waSid ? 'sent' : 'failed',
    });

    wsEvents.orderUpdated({ order_id: id, status: 'confirmed', whatsapp_sent: !!waSid });
    res.json({ success: true, message: 'Order accepted', data: { ...updated, whatsapp_sent: !!waSid } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PATCH /api/admin/orders/:id/reject  (protected) ───────────
router.patch('/:id/reject', verifyToken, async (req, res) => {
  try {
    const { id }     = req.params;
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Rejection reason is required' });

    const supabase = getSupabase();
    const { order, error: fetchErr } = await fetchOrderWithItems(supabase, id);
    if (fetchErr || !order)
      return res.status(404).json({ success: false, message: 'Order not found' });

    // If order was already paid → initiate refund first
    if (order.payment_status === 'paid' && order.razorpay_payment_id) {
      const refund = await initiateRefund(
        order.razorpay_payment_id,
        order.total_amount,
        reason || 'Order rejected by restaurant'
      );
      if (refund) {
        await supabase
          .from('orders')
          .update({ payment_status: 'refunded' })
          .eq('id', id);
        await supabase.from('notification_logs').insert({
          order_id: id,
          type:     'refund_initiated',
          phone:    order.customer_phone,
          message:  `Refund of ₹${order.total_amount} initiated. Refund ID: ${refund.id}`,
          status:   'sent',
        });
      }
    }

    const { data: updated, error } = await supabase
      .from('orders')
      .update({
        status:           'rejected',
        rejection_reason: reason,
        updated_at:       new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, status, rejection_reason')
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Update failed', error: error.message });

    const waSid = await sendOrderRejected(
      order.customer_phone, order.customer_name, order.order_number, reason
    );

    await supabase.from('notification_logs').insert({
      order_id: id, type: 'order_rejected', phone: order.customer_phone,
      message:  `Order #${order.order_number} rejected: ${reason}`,
      status:   waSid ? 'sent' : 'failed',
    });

    wsEvents.orderUpdated({ order_id: id, status: 'rejected', whatsapp_sent: !!waSid });
    res.json({ success: true, message: 'Order rejected', data: { ...updated, whatsapp_sent: !!waSid } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PATCH /api/admin/orders/:id/in-kitchen  (protected) ───────
router.patch('/:id/in-kitchen', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('orders')
      .update({ status: 'in_kitchen', updated_at: new Date().toISOString() })
      .eq('id', id).select('id, status').single();
    if (error) return res.status(400).json({ success: false, message: 'Update failed', error: error.message });
    wsEvents.orderUpdated({ order_id: id, status: 'in_kitchen' });
    res.json({ success: true, message: 'Order moved to kitchen', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PATCH /api/admin/orders/:id/ready  (protected) ────────────
router.patch('/:id/ready', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('orders')
      .update({ status: 'ready', updated_at: new Date().toISOString() })
      .eq('id', id).select('id, status').single();
    if (error) return res.status(400).json({ success: false, message: 'Update failed', error: error.message });
    wsEvents.orderUpdated({ order_id: id, status: 'ready' });
    res.json({ success: true, message: 'Order is ready', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PATCH /api/admin/orders/:id/out-for-delivery  (protected) ─
router.patch('/:id/out-for-delivery', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('orders')
      .update({ status: 'out_for_delivery', updated_at: new Date().toISOString() })
      .eq('id', id).select('id, status').single();
    if (error) return res.status(400).json({ success: false, message: 'Update failed', error: error.message });
    wsEvents.orderUpdated({ order_id: id, status: 'out_for_delivery' });
    res.json({ success: true, message: 'Order out for delivery', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PATCH /api/admin/orders/:id/delivered  (protected) ────────
router.patch('/:id/delivered', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();

    const { order, error: fetchErr } = await fetchOrderWithItems(supabase, id);
    if (fetchErr || !order)
      return res.status(404).json({ success: false, message: 'Order not found' });

    const now                  = new Date();
    const completed_at         = now.toISOString();
    const review_scheduled_at  = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    const { data: updated, error } = await supabase
      .from('orders')
      .update({
        status:               'delivered',
        completed_at,
        review_scheduled_at,
        review_sent:          false,
        updated_at:           completed_at,
      })
      .eq('id', id)
      .select('id, status, completed_at, review_scheduled_at, review_sent')
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Update failed', error: error.message });

    await supabase.from('notification_logs').insert({
      order_id: id, type: 'review_request', phone: order.customer_phone,
      message:  `Review request scheduled for ${review_scheduled_at}`,
      status:   'pending',
    });

    wsEvents.orderDelivered({ order_id: id, status: 'delivered', completed_at });
    res.json({
      success: true,
      message: 'Order marked as delivered. Review request scheduled.',
      data: updated,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/admin/orders/:id  (protected) ────────────────────
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();
    const { order, error } = await fetchOrderWithItems(supabase, id);

    if (error || !order)
      return res.status(404).json({ success: false, message: 'Order not found' });

    res.json({ success: true, message: 'Order fetched', data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

module.exports = router;
