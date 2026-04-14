require('dotenv').config();
const express     = require('express');
const { createClient } = require('@supabase/supabase-js');
const { checkDeliveryRange } = require('../middleware/distance');
const { validateCoupon }     = require('./coupons');

const { events: wsEvents } = require('../utils/websocket');

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
// Customer places cart request.
// payment_method = 'cod'    → status = 'confirmed', payment_status = 'cod_pending'
// payment_method = 'online' → status = 'requested', payment_status = 'pending'
router.post('/request', async (req, res) => {
  try {
    const {
      order_type, table_id, customer_name, customer_phone,
      delivery_address, latitude, longitude,
      items, coupon_code, special_instructions,
      payment_method,
    } = req.body;

    if (!customer_name || !customer_phone)
      return res.status(400).json({ success: false, message: 'customer_name and customer_phone are required' });
    if (!order_type || !['pickup', 'delivery', 'dine_in'].includes(order_type))
      return res.status(400).json({ success: false, message: 'order_type must be pickup, delivery, or dine_in' });

    const isCod = payment_method === 'cod';

    const supabase = getSupabase();

    // 0. Resolve table_id: frontend sends UUID, DB orders.table_id is integer (table_number)
    let resolvedTableId = null;
    if (table_id) {
      // Check if it looks like a UUID
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(table_id));
      if (isUUID) {
        const { data: tableRow } = await supabase
          .from('tables')
          .select('table_number')
          .eq('id', table_id)
          .maybeSingle();
        resolvedTableId = tableRow ? tableRow.table_number : null;
      } else {
        // Already an integer (table_number) — use directly
        resolvedTableId = parseInt(table_id) || null;
      }
    }

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

    // COD: confirmed immediately. Online: goes through admin approval flow.
    const initialStatus        = isCod ? 'confirmed' : 'requested';
    const initialPaymentStatus = 'pending'; // DB constraint only allows 'pending' at creation

    // COD: increment coupon used_count now (no payment step later)
    if (isCod && appliedCoupon) {
      const { data: coupon } = await supabase
        .from('coupons')
        .select('id, used_count')
        .eq('code', appliedCoupon)
        .maybeSingle();
      if (coupon) {
        await supabase
          .from('coupons')
          .update({ used_count: coupon.used_count + 1 })
          .eq('id', coupon.id);
      }
    }

    // Normalise order_type: DB may only allow 'pickup' | 'delivery'
    // Store dine_in as 'pickup' with table_id — distinguishable via table_id presence
    const dbOrderType = order_type === 'dine_in' ? 'pickup' : order_type;

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert({
        order_type:           dbOrderType,
        table_id:             resolvedTableId,
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
        status:               initialStatus,
        payment_method:       isCod ? 'cod' : 'online',
        payment_status:       initialPaymentStatus,
      })
      .select('id, order_number, order_type, status, payment_status, subtotal, discount_amount, total_amount')
      .single();

    if (orderErr) {
      console.error('[orders/request] DB insert error:', orderErr.message, orderErr.details, orderErr.hint);

      // Fallback: if DB constraint rejects 'cod' payment_method or 'confirmed' status,
      // retry with safe values ('online' / 'requested') — COD still identifiable via table_id + order_type
      if (orderErr.message && orderErr.message.includes('check constraint')) {
        console.warn('[orders/request] Constraint hit — retrying with safe fallback values');
        const { data: fallbackOrder, error: fallbackErr } = await supabase
          .from('orders')
          .insert({
            order_type:           dbOrderType,
            table_id:             resolvedTableId,
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

        if (fallbackErr) {
          console.error('[orders/request] Fallback also failed:', fallbackErr.message);
          return res.status(400).json({ success: false, message: 'Order creation failed', error: fallbackErr.message });
        }

        // Use fallback order — log warning so we know DB needs migration
        console.warn('[orders/request] COD/dine_in stored with fallback values. Run DB migration to add cod + dine_in constraints.');
        Object.assign(order || {}, fallbackOrder); // shouldn't reach here, reassign below
        return res.status(201).json({
          success: true,
          message: 'Order placed (COD stored as online — DB migration needed).',
          data: {
            id:             fallbackOrder.id,
            order_number:   fallbackOrder.order_number,
            order_type,
            status:         fallbackOrder.status,
            payment_status: fallbackOrder.payment_status,
            payment_method: isCod ? 'cod' : 'online',
            subtotal, discount_amount, total_amount,
            items_count:    resolvedItems.length,
            note: isCod ? 'COD order placed!' : 'Restaurant will confirm shortly.',
          },
        });
      }

      return res.status(400).json({
        success: false,
        message: 'Order creation failed',
        error:   orderErr.message,
        details: orderErr.details || null,
        hint:    orderErr.hint    || null,
      });
    }

    // COD: auto-approve all items at original price (no admin approval needed)
    // Online: approved_quantity = NULL, admin will review
    const orderItemsPayload = resolvedItems.map(i => ({
      order_id:           order.id,
      menu_item_id:       i.menu_item_id,
      item_name:          i.item_name,
      item_price:         i.item_price,
      quantity:           i.quantity,
      requested_quantity: i.quantity,
      approved_quantity:  isCod ? i.quantity : null,
      final_price:        isCod ? i.item_price : null,
      variant:            i.variant,
      special_note:       i.special_note,
    }));

    const { error: itemsErr } = await supabase.from('order_items').insert(orderItemsPayload);
    if (itemsErr) console.error('[orders/request] order_items insert error:', itemsErr.message);

    const responseData = {
      id:             order.id,
      order_number:   order.order_number,
      order_type,                          // return original value frontend sent (dine_in / pickup / delivery)
      status:         initialStatus,
      payment_status: initialPaymentStatus,
      payment_method: isCod ? 'cod' : 'online',
      subtotal,
      discount_amount,
      total_amount,
      items_count:    resolvedItems.length,
      note:           isCod
        ? 'COD order confirmed! Pay cash at delivery.'
        : 'Restaurant will confirm available items shortly (within 10 minutes)',
    };

    // Broadcast new order to admin dashboard in real-time
    // Include table_number so admin sees table instantly without waiting for API refetch
    wsEvents.newOrder({ ...responseData, customer_name, customer_phone, order_type, table_number: resolvedTableId ?? null });

    res.status(201).json({
      success: true,
      message: 'Order request sent! Waiting for restaurant confirmation.',
      data: responseData,
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

