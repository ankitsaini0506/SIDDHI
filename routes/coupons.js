require('dotenv').config();
const express     = require('express');
const { createClient } = require('@supabase/supabase-js');
const verifyToken = require('../middleware/auth');

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── Shared coupon validation + discount calculation ────────
async function validateCoupon(supabase, code, order_total) {
  const { data: coupon, error } = await supabase
    .from('coupons')
    .select('*')
    .eq('code', code.toUpperCase())
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!coupon) return { valid: false, message: 'Coupon not found' };

  if (!coupon.is_active)
    return { valid: false, message: 'Coupon is currently inactive' };

  const today = new Date().toISOString().split('T')[0];
  if (coupon.valid_from && today < coupon.valid_from)
    return { valid: false, message: 'Coupon has expired' };
  if (coupon.valid_until && today > coupon.valid_until)
    return { valid: false, message: 'Coupon has expired' };

  if (order_total < (coupon.min_order_amount || 0))
    return { valid: false, message: `Minimum order ₹${coupon.min_order_amount} required for this coupon` };

  if (coupon.used_count >= coupon.usage_limit)
    return { valid: false, message: 'Coupon usage limit has been reached' };

  // Calculate discount
  let discount_amount = 0;
  if (coupon.discount_type === 'percentage') {
    discount_amount = Math.floor((order_total * coupon.discount_value) / 100);
    if (coupon.max_discount_amount)
      discount_amount = Math.min(discount_amount, coupon.max_discount_amount);
  } else {
    discount_amount = coupon.discount_value;
  }

  const final_amount = order_total - discount_amount;

  return { valid: true, coupon, discount_amount, final_amount };
}

module.exports.validateCoupon = validateCoupon;

// ── POST /api/coupons/validate  (PUBLIC) ──────────────────
// Must be before /:id routes
router.post('/validate', async (req, res) => {
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

// ── GET /api/coupons  (protected) ─────────────────────────
router.get('/', verifyToken, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('coupons')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    res.json({ success: true, message: 'Coupons fetched', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/coupons  (protected) ────────────────────────
router.post('/', verifyToken, async (req, res) => {
  try {
    let {
      code, title, description, discount_type, discount_value,
      min_order_amount, max_discount_amount, usage_limit,
      valid_from, valid_until, is_active,
    } = req.body;

    if (!code || !title || !discount_type || discount_value === undefined)
      return res.status(400).json({ success: false, message: 'code, title, discount_type and discount_value are required' });

    code = code.toUpperCase();

    const supabase = getSupabase();

    // Check duplicate
    const { data: existing } = await supabase
      .from('coupons')
      .select('id')
      .eq('code', code)
      .maybeSingle();

    if (existing)
      return res.status(400).json({ success: false, message: 'Coupon code already exists' });

    const { data, error } = await supabase
      .from('coupons')
      .insert({
        code,
        title,
        description:         description         || null,
        discount_type,
        discount_value:      parseInt(discount_value),
        min_order_amount:    min_order_amount     ? parseInt(min_order_amount)    : 0,
        max_discount_amount: max_discount_amount  ? parseInt(max_discount_amount) : null,
        usage_limit:         usage_limit          ? parseInt(usage_limit)         : 100,
        valid_from:          valid_from           || null,
        valid_until:         valid_until          || null,
        is_active:           is_active            ?? true,
        used_count:          0,
      })
      .select('id, code, title, discount_type, discount_value, is_active')
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Insert failed', error: error.message });

    res.status(201).json({ success: true, message: 'Coupon created', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/coupons/:id/stats  (protected) ───────────────
router.get('/:id/stats', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();

    const { data: coupon, error } = await supabase
      .from('coupons')
      .select('id, code, used_count, usage_limit')
      .eq('id', id)
      .maybeSingle();

    if (error || !coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });

    // Sum discount_amount from orders that used this coupon
    const { data: orders } = await supabase
      .from('orders')
      .select('discount_amount')
      .eq('coupon_code', coupon.code);

    const total_savings = (orders || []).reduce((sum, o) => sum + (o.discount_amount || 0), 0);

    res.json({
      success: true,
      message: 'Coupon stats fetched',
      data: {
        code:          coupon.code,
        used_count:    coupon.used_count,
        usage_limit:   coupon.usage_limit,
        total_savings,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PUT /api/coupons/:id  (protected) ─────────────────────
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      code, title, description, discount_type, discount_value,
      min_order_amount, max_discount_amount, usage_limit,
      valid_from, valid_until, is_active,
    } = req.body;

    const updates = {};
    if (code               !== undefined) updates.code               = code.toUpperCase();
    if (title              !== undefined) updates.title              = title;
    if (description        !== undefined) updates.description        = description;
    if (discount_type      !== undefined) updates.discount_type      = discount_type;
    if (discount_value     !== undefined) updates.discount_value     = parseInt(discount_value);
    if (min_order_amount   !== undefined) updates.min_order_amount   = parseInt(min_order_amount);
    if (max_discount_amount!== undefined) updates.max_discount_amount= max_discount_amount ? parseInt(max_discount_amount) : null;
    if (usage_limit        !== undefined) updates.usage_limit        = parseInt(usage_limit);
    if (valid_from         !== undefined) updates.valid_from         = valid_from;
    if (valid_until        !== undefined) updates.valid_until        = valid_until;
    if (is_active          !== undefined) updates.is_active          = is_active;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('coupons')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Update failed', error: error.message });

    res.json({ success: true, message: 'Coupon updated', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PATCH /api/coupons/:id/toggle  (protected) ────────────
router.patch('/:id/toggle', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    if (is_active === undefined)
      return res.status(400).json({ success: false, message: 'is_active field required' });

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('coupons')
      .update({ is_active })
      .eq('id', id)
      .select('id, code, is_active')
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Toggle failed', error: error.message });

    res.json({ success: true, message: `Coupon ${is_active ? 'activated' : 'deactivated'}`, data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── DELETE /api/coupons/:id  (protected) ──────────────────
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();

    const { error } = await supabase.from('coupons').delete().eq('id', id);
    if (error) return res.status(400).json({ success: false, message: 'Delete failed', error: error.message });

    res.json({ success: true, message: 'Coupon deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

module.exports = router;
module.exports.validateCoupon = validateCoupon;
