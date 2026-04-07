require('dotenv').config();
const express     = require('express');
const crypto      = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const verifyToken = require('../middleware/auth');
const {
  createRazorpayOrder,
  verifyPaymentSignature,
} = require('../utils/razorpay');

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Helper — fetch approved order_items for an order
async function getApprovedItems(supabase, orderId) {
  const { data } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', orderId)
    .gt('approved_quantity', 0);
  return data || [];
}

// ── POST /api/payments/create-order  (PUBLIC) ────────────────
router.post('/create-order', async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id)
      return res.status(400).json({ success: false, message: 'order_id is required' });

    const supabase = getSupabase();
    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', order_id)
      .maybeSingle();

    if (error || !order)
      return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.status !== 'payment_pending')
      return res.status(400).json({
        success: false,
        message: `Order is not ready for payment. Status: ${order.status}`,
      });

    if (order.payment_status !== 'pending')
      return res.status(400).json({
        success: false,
        message: `Payment already processed for this order. Status: ${order.payment_status}`,
      });

    if (!order.total_amount || order.total_amount <= 0)
      return res.status(400).json({ success: false, message: 'Order total is zero. Nothing to pay.' });

    // Create Razorpay order
    const rzpOrder = await createRazorpayOrder(order.total_amount, `SIDDHI_${order.order_number}`);

    // Save razorpay_order_id to DB
    await supabase
      .from('orders')
      .update({ razorpay_order_id: rzpOrder.id })
      .eq('id', order_id);

    // Fetch approved items for summary
    const items = await getApprovedItems(supabase, order_id);

    res.json({
      success: true,
      message: 'Razorpay order created. Proceed to payment.',
      data: {
        razorpay_order_id: rzpOrder.id,
        amount:            rzpOrder.amount,
        amount_display:    order.total_amount,
        currency:          'INR',
        key_id:            process.env.RAZORPAY_KEY_ID,
        prefill: {
          name:    order.customer_name,
          contact: '91' + String(order.customer_phone).replace(/\D/g, '').slice(-10),
        },
        order_summary: {
          order_number:    order.order_number,
          items: items.map(i => ({
            name:       i.item_name,
            quantity:   i.approved_quantity,
            unit_price: i.final_price ?? i.item_price,
            subtotal:   i.approved_quantity * (i.final_price ?? i.item_price),
          })),
          subtotal:        order.subtotal,
          discount_amount: order.discount_amount,
          total:           order.total_amount,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/payments/verify  (PUBLIC) ──────────────────────
router.post('/verify', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      order_id,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !order_id)
      return res.status(400).json({ success: false, message: 'All payment fields are required' });

    const supabase = getSupabase();
    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('id', order_id)
      .maybeSingle();

    if (!order)
      return res.status(404).json({ success: false, message: 'Order not found' });

    // Already paid — idempotent: return success without re-processing
    if (order.payment_status === 'paid') {
      return res.json({
        success: true,
        message: 'Payment already verified.',
        data: {
          order_id,
          order_number:   order.order_number,
          status:         order.status,
          payment_status: 'paid',
          payment_id:     order.razorpay_payment_id,
          paid_amount:    order.total_amount,
        },
      });
    }

    const isValid = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);

    if (!isValid) {
      await supabase
        .from('orders')
        .update({ payment_status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', order_id);

      return res.status(400).json({
        success: false,
        message: 'Payment verification failed. Please contact support.',
        data: { order_id, payment_status: 'failed' },
      });
    }

    // Valid payment — confirm order
    await supabase
      .from('orders')
      .update({
        payment_status:      'paid',
        razorpay_payment_id,
        razorpay_signature,
        paid_at:             new Date().toISOString(),
        status:              'confirmed',
        updated_at:          new Date().toISOString(),
      })
      .eq('id', order_id);

    // Increment coupon used_count now (delayed from order placement)
    if (order.coupon_code) {
      const { data: coupon } = await supabase
        .from('coupons')
        .select('id, used_count')
        .eq('code', order.coupon_code)
        .maybeSingle();

      if (coupon) {
        await supabase
          .from('coupons')
          .update({ used_count: coupon.used_count + 1 })
          .eq('id', coupon.id);
      }
    }

    const items = await getApprovedItems(supabase, order_id);

    res.json({
      success: true,
      message: 'Payment successful! Your order is confirmed.',
      data: {
        order_id,
        order_number:    order.order_number,
        status:          'confirmed',
        payment_status:  'paid',
        payment_id:      razorpay_payment_id,
        paid_amount:     order.total_amount,
        items: items.map(i => ({
          name:       i.item_name,
          quantity:   i.approved_quantity,
          unit_price: i.final_price ?? i.item_price,
          subtotal:   i.approved_quantity * (i.final_price ?? i.item_price),
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/payments/webhook  (PUBLIC — Razorpay server) ───
// Note: raw body parsing is set up in server.js before express.json()
router.post('/webhook', async (req, res) => {
  try {
    const rawBody  = req.body.toString();
    const signature = req.headers['x-razorpay-signature'];

    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(rawBody)
      .digest('hex');

    if (signature !== expected) {
      console.warn('[webhook] Invalid signature');
      return res.status(400).send('Invalid webhook signature');
    }

    const event    = JSON.parse(rawBody);
    const supabase = getSupabase();

    if (event.event === 'payment.captured') {
      const rzpOrderId = event.payload.payment.entity.order_id;
      const rzpPayId   = event.payload.payment.entity.id;

      const { data: order } = await supabase
        .from('orders')
        .select('id, order_number, payment_status, coupon_code')
        .eq('razorpay_order_id', rzpOrderId)
        .maybeSingle();

      if (order && order.payment_status !== 'paid') {
        await supabase
          .from('orders')
          .update({
            payment_status:      'paid',
            razorpay_payment_id: rzpPayId,
            paid_at:             new Date().toISOString(),
            status:              'confirmed',
            updated_at:          new Date().toISOString(),
          })
          .eq('id', order.id);

        if (order.coupon_code) {
          const { data: coupon } = await supabase
            .from('coupons')
            .select('id, used_count')
            .eq('code', order.coupon_code)
            .maybeSingle();
          if (coupon) {
            await supabase
              .from('coupons')
              .update({ used_count: coupon.used_count + 1 })
              .eq('id', coupon.id);
          }
        }

        console.log(`[webhook] Payment confirmed for order #${order.order_number}`);
      }
    }

    if (event.event === 'payment.failed') {
      const rzpOrderId = event.payload.payment.entity.order_id;
      const { data: order } = await supabase
        .from('orders')
        .select('id, order_number')
        .eq('razorpay_order_id', rzpOrderId)
        .maybeSingle();

      if (order) {
        await supabase
          .from('orders')
          .update({ payment_status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', order.id);
        console.log(`[webhook] Payment failed for order #${order.order_number}`);
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook] Error:', err.message);
    res.status(200).json({ received: true }); // always 200 so Razorpay doesn't retry
  }
});

// ── GET /api/payments/status/:orderId  (PUBLIC) ───────────────
router.get('/status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const supabase    = getSupabase();

    const { data: order, error } = await supabase
      .from('orders')
      .select('id, order_number, status, payment_status, total_amount, paid_at')
      .eq('id', orderId)
      .maybeSingle();

    if (error || !order)
      return res.status(404).json({ success: false, message: 'Order not found' });

    const items = await getApprovedItems(supabase, orderId);

    res.json({
      success: true,
      message: 'Payment status fetched',
      data: {
        order_id:       orderId,
        order_number:   order.order_number,
        status:         order.status,
        payment_status: order.payment_status,
        paid_amount:    order.payment_status === 'paid' ? order.total_amount : 0,
        paid_at:        order.paid_at,
        can_retry: order.payment_status === 'failed' ||
                   (order.status === 'payment_pending' && order.payment_status === 'pending'),
        approved_items: items.map(i => ({
          item_name:          i.item_name,
          requested_quantity: i.requested_quantity,
          approved_quantity:  i.approved_quantity,
          unit_price:         i.final_price ?? i.item_price,
          subtotal:           i.approved_quantity * (i.final_price ?? i.item_price),
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/payments/cancel-request  (PUBLIC) ──────────────
router.post('/cancel-request', async (req, res) => {
  try {
    const { order_id, customer_phone } = req.body;
    if (!order_id || !customer_phone)
      return res.status(400).json({ success: false, message: 'order_id and customer_phone are required' });

    const supabase = getSupabase();
    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', order_id)
      .maybeSingle();

    if (error || !order)
      return res.status(404).json({ success: false, message: 'Order not found' });

    const phone = String(customer_phone).replace(/\D/g, '').slice(-10);
    const stored = String(order.customer_phone).replace(/\D/g, '').slice(-10);
    if (phone !== stored)
      return res.status(403).json({ success: false, message: 'Not your order' });

    if (order.payment_status === 'paid')
      return res.status(400).json({ success: false, message: 'Cannot cancel a paid order' });

    if (!['requested', 'payment_pending'].includes(order.status))
      return res.status(400).json({
        success: false,
        message: `Order cannot be cancelled at this stage. Status: ${order.status}`,
      });

    await supabase
      .from('orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', order_id);

    res.json({ success: true, message: 'Order cancelled successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/admin/payments  (verifyToken) ────────────────────
router.get('/admin-list', verifyToken, async (req, res) => {
  try {
    const { status, filter } = req.query;
    const supabase = getSupabase();

    let query = supabase
      .from('orders')
      .select('id, order_number, customer_name, customer_phone, order_type, total_amount, payment_status, razorpay_payment_id, paid_at, created_at')
      .order('created_at', { ascending: false });

    if (status) query = query.eq('payment_status', status);

    // Date filter uses created_at (paid_at may be null for non-paid orders)
    if (filter === 'today') {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      query = query.gte('created_at', today.toISOString());
    } else if (filter === 'weekly') {
      query = query.gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
    } else if (filter === 'monthly') {
      query = query.gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    } else {
      // Default: all orders with payment columns
      query = query.not('payment_status', 'is', null);
    }

    const { data: orders, error } = await query;
    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    // Attach approved items to each order
    const result = await Promise.all((orders || []).map(async (order) => {
      const { data: items } = await supabase
        .from('order_items')
        .select('item_name, approved_quantity, final_price, item_price')
        .eq('order_id', order.id)
        .gt('approved_quantity', 0);
      return {
        ...order,
        items: (items || []).map(i => ({
          item_name:        i.item_name,
          approved_quantity: i.approved_quantity,
          final_price:      i.final_price,
          effective_price:  i.final_price ?? i.item_price,
          item_subtotal:    i.approved_quantity * (i.final_price ?? i.item_price),
        })),
      };
    }));

    // Summary
    const paid     = (orders || []).filter(o => o.payment_status === 'paid');
    const failed   = (orders || []).filter(o => o.payment_status === 'failed').length;
    const refunded = (orders || []).filter(o => o.payment_status === 'refunded').length;
    const total_collected = paid.reduce((s, o) => s + (o.total_amount || 0), 0);
    const paid_orders     = paid.length;
    const avg_order_value = paid_orders > 0 ? Math.round(total_collected / paid_orders) : 0;

    res.json({
      success: true,
      message: 'Payment list fetched',
      data: result,
      summary: {
        total_collected,
        paid_orders,
        failed_payments: failed,
        refunded,
        avg_order_value,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

module.exports = router;
