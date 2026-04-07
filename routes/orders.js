require('dotenv').config();
const express     = require('express');
const { createClient } = require('@supabase/supabase-js');
const { checkDeliveryRange } = require('../middleware/distance');
const { validateCoupon }     = require('./coupons');

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── POST /api/orders/check-delivery  (PUBLIC) ─────────────────
router.post('/check-delivery', (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    if (!latitude || !longitude)
      return res.status(400).json({ success: false, message: 'latitude and longitude are required' });

    const result = checkDeliveryRange(latitude, longitude);
    const max_km = parseFloat(process.env.DELIVERY_RADIUS_KM) || 5;

    res.json({
      success: true,
      data: {
        delivery_available: result.allowed,
        distance_km:        result.distance_km,
        max_km,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/orders/apply-coupon  (PUBLIC) ──────────────────
router.post('/apply-coupon', async (req, res) => {
  try {
    const { code, order_total } = req.body;
    if (!code || order_total === undefined)
      return res.status(400).json({ success: false, message: 'code and order_total are required' });

    const supabase = getSupabase();
    const result = await validateCoupon(supabase, code, Number(order_total));

    if (!result.valid)
      return res.status(400).json({ success: false, message: result.message });

    res.json({
      success: true,
      message: 'Coupon applied',
      data: {
        valid:           true,
        code:            result.coupon.code,
        discount_amount: result.discount_amount,
        final_amount:    result.final_amount,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/orders/request  (PUBLIC) ────────────────────────
// Customer places cart request. NO payment at this step.
// status = 'requested', approved_quantity = NULL for all items
router.post('/request', async (req, res) => {
  try {
    const {
      order_type, table_id, customer_name, customer_phone,
      delivery_address, latitude, longitude,
      items, coupon_code, special_instructions,
    } = req.body;

    if (!customer_name || !customer_phone)
      return res.status(400).json({ success: false, message: 'customer_name and customer_phone are required' });
    if (!order_type || !['pickup', 'delivery'].includes(order_type))
      return res.status(400).json({ success: false, message: 'order_type must be pickup or delivery' });

    const supabase = getSupabase();

    // 1. Delivery distance check
    if (order_type === 'delivery') {
      if (!latitude || !longitude)
        return res.status(400).json({ success: false, message: 'latitude and longitude required for delivery' });

      const distCheck = checkDeliveryRange(latitude, longitude);
      if (!distCheck.allowed)
        return res.status(400).json({
          success: false,
          message: `Delivery not available. Distance: ${distCheck.distance_km} km (max ${process.env.DELIVERY_RADIUS_KM || 5} km)`,
        });
    }

    // 2. Items required
    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ success: false, message: 'Add at least one item' });

    // 3. Validate each item + calculate subtotal from DB prices
    // NOTE: do NOT check is_available here — admin decides
    let subtotal = 0;
    const resolvedItems = [];

    for (const item of items) {
      const { data: menuItem, error: itemErr } = await supabase
        .from('menu_items')
        .select('id, name, price, variants')
        .eq('id', item.menu_item_id)
        .maybeSingle();

      if (itemErr || !menuItem)
        return res.status(400).json({ success: false, message: `Item not found: ${item.menu_item_id}` });

      let itemPrice = menuItem.price;
      if (item.variant && Array.isArray(menuItem.variants)) {
        const variantMatch = menuItem.variants.find(
          v => v.name && v.name.toLowerCase() === item.variant.toLowerCase()
        );
        if (variantMatch && variantMatch.price) itemPrice = variantMatch.price;
      }

      const qty = parseInt(item.quantity) || 1;
      subtotal += itemPrice * qty;

      resolvedItems.push({
        menu_item_id: menuItem.id,
        item_name:    menuItem.name,
        item_price:   itemPrice,
        quantity:     qty,
        variant:      item.variant   || null,
        special_note: item.special_note || null,
      });
    }

    // 4. Coupon preview (DO NOT increment used_count yet)
    let discount_amount = 0;
    const appliedCoupon = coupon_code ? coupon_code.toUpperCase() : null;

    if (appliedCoupon) {
      const couponResult = await validateCoupon(supabase, appliedCoupon, subtotal);
      if (!couponResult.valid)
        return res.status(400).json({ success: false, message: couponResult.message });
      discount_amount = couponResult.discount_amount;
      // used_count incremented ONLY after payment verified
    }

    const total_amount = subtotal - discount_amount;

    // Insert order with status = 'requested'
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert({
        order_type,
        table_id:             table_id             || null,
        customer_name,
        customer_phone:       String(customer_phone),
        delivery_address:     delivery_address     || null,
        latitude:             latitude             ? parseFloat(latitude)  : null,
        longitude:            longitude            ? parseFloat(longitude) : null,
        subtotal,
        discount_amount,
        total_amount,
        coupon_code:          appliedCoupon        || null,
        special_instructions: special_instructions || null,
        status:               'requested',
        payment_method:       'online',
        payment_status:       'pending',
      })
      .select('id, order_number, order_type, status, payment_status, subtotal, discount_amount, total_amount')
      .single();

    if (orderErr)
      return res.status(400).json({ success: false, message: 'Order creation failed', error: orderErr.message });

    // Insert order_items with requested_quantity set, approved_quantity = NULL
    const orderItemsPayload = resolvedItems.map(i => ({
      order_id:           order.id,
      menu_item_id:       i.menu_item_id,
      item_name:          i.item_name,
      item_price:         i.item_price,
      quantity:           i.quantity,
      requested_quantity: i.quantity,   // copy — never changes
      approved_quantity:  null,         // admin will set
      final_price:        null,         // admin will set
      variant:            i.variant,
      special_note:       i.special_note,
    }));

    const { error: itemsErr } = await supabase.from('order_items').insert(orderItemsPayload);
    if (itemsErr) console.error('[orders/request] order_items insert error:', itemsErr.message);

    res.status(201).json({
      success: true,
      message: 'Order request sent! Waiting for restaurant confirmation.',
      data: {
        id:             order.id,
        order_number:   order.order_number,
        status:         'requested',
        payment_status: 'pending',
        subtotal,
        discount_amount,
        total_amount,
        items_count:    resolvedItems.length,
        note:           'Restaurant will confirm available items shortly (within 10 minutes)',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/orders/:id/track  (PUBLIC) ───────────────────────
router.get('/:id/track', async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();

    const { data: order, error } = await supabase
      .from('orders')
      .select('order_number, status, payment_status, estimated_time_mins, order_type, total_amount, subtotal, discount_amount')
      .eq('id', id)
      .maybeSingle();

    if (error || !order)
      return res.status(404).json({ success: false, message: 'Order not found' });

    // Fetch all order items
    const { data: allItems } = await supabase
      .from('order_items')
      .select('*')
      .eq('order_id', id);

    const items = allItems || [];

    // Approved items (approved_quantity > 0)
    const approvedItems = items
      .filter(i => i.approved_quantity > 0)
      .map(i => ({
        id:                 i.id,
        item_name:          i.item_name,
        requested_quantity: i.requested_quantity,
        approved_quantity:  i.approved_quantity,
        final_price:        i.final_price,
        effective_price:    i.final_price ?? i.item_price,
        item_subtotal:      i.approved_quantity * (i.final_price ?? i.item_price),
        admin_note:         i.admin_note,
      }));

    // Pending items (not yet reviewed by admin)
    const pendingItems = items.filter(i => i.approved_quantity === null);

    // Approved total
    const approved_total = approvedItems.reduce((s, i) => s + i.item_subtotal, 0);

    res.json({
      success: true,
      message: 'Order tracked',
      data: {
        ...order,
        can_pay:         order.status === 'payment_pending' && order.payment_status === 'pending',
        razorpay_key_id: process.env.RAZORPAY_KEY_ID,
        approved_items:  approvedItems,
        pending_items:   pendingItems,
        approved_total,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/orders/:id  (PUBLIC) ─────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();

    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !order)
      return res.status(404).json({ success: false, message: 'Order not found' });

    const { data: items } = await supabase
      .from('order_items')
      .select('*')
      .eq('order_id', id);

    res.json({
      success: true,
      message: 'Order fetched',
      data: { ...order, items: items || [] },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

module.exports = router;
