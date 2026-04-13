require('dotenv').config();
const express     = require('express');
const { createClient } = require('@supabase/supabase-js');
const verifyToken = require('../middleware/auth');
const { uploadLogo } = require('../middleware/upload');

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Helper — fetch first restaurant row
async function getRestaurant(supabase) {
  const { data, error } = await supabase
    .from('restaurants')
    .select('*')
    .limit(1)
    .maybeSingle();
  return { data, error };
}

// ── GET /api/restaurant  (PUBLIC) ────────────────────────
router.get('/', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await getRestaurant(supabase);

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });
    if (!data)  return res.status(404).json({ success: false, message: 'Restaurant not found' });

    res.json({ success: true, message: 'Restaurant fetched', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PUT /api/restaurant  (protected) ─────────────────────
router.put('/', verifyToken, async (req, res) => {
  try {
    const {
      name, address, phone, opening_time, closing_time,
      delivery_radius_km, whatsapp_number, is_open, google_review_link,
    } = req.body;

    const supabase = getSupabase();
    const { data: existing, error: fe } = await getRestaurant(supabase);
    if (fe || !existing) return res.status(404).json({ success: false, message: 'Restaurant not found' });

    const updates = {};
    if (name               !== undefined) updates.name               = name;
    if (address            !== undefined) updates.address            = address;
    if (phone              !== undefined) updates.phone              = phone;
    if (opening_time       !== undefined) updates.opening_time       = opening_time;
    if (closing_time       !== undefined) updates.closing_time       = closing_time;
    if (delivery_radius_km !== undefined) updates.delivery_radius_km = delivery_radius_km;
    if (whatsapp_number    !== undefined) updates.whatsapp_number    = whatsapp_number;
    if (is_open            !== undefined) updates.is_open            = is_open;
    if (google_review_link !== undefined) updates.google_review_link = google_review_link;

    const { data, error } = await supabase
      .from('restaurants')
      .update(updates)
      .eq('id', existing.id)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Update failed', error: error.message });

    res.json({ success: true, message: 'Restaurant updated', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/restaurant/logo  (protected + upload) ──────
router.post('/logo', verifyToken, uploadLogo.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const logo_url = req.file.path; // Cloudinary secure URL
    const supabase = getSupabase();
    const { data: existing } = await getRestaurant(supabase);
    if (!existing) return res.status(404).json({ success: false, message: 'Restaurant not found' });

    await supabase
      .from('restaurants')
      .update({ logo_url })
      .eq('id', existing.id);

    res.json({ success: true, message: 'Logo uploaded', data: { logo_url } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PATCH /api/restaurant/toggle-status  (protected) ─────
// Supports both: body with { is_open: boolean } OR no body (server-side flip)
router.patch('/toggle-status', verifyToken, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data: existing } = await getRestaurant(supabase);
    if (!existing) return res.status(404).json({ success: false, message: 'Restaurant not found' });

    // If frontend sends a value, use it; otherwise flip the current value
    const is_open = req.body?.is_open !== undefined ? req.body.is_open : !existing.is_open;

    const { data, error } = await supabase
      .from('restaurants')
      .update({ is_open })
      .eq('id', existing.id)
      .select('id, name, is_open')
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Update failed', error: error.message });

    res.json({ success: true, message: `Restaurant is now ${is_open ? 'open' : 'closed'}`, data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/restaurant/hours  (PUBLIC) ──────────────────
router.get('/hours', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await getRestaurant(supabase);

    if (error || !data) return res.status(404).json({ success: false, message: 'Restaurant not found' });

    res.json({ success: true, message: 'Operating hours fetched', data: { operating_hours: data.operating_hours } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PUT /api/restaurant/hours  (protected) ───────────────
router.put('/hours', verifyToken, async (req, res) => {
  try {
    const operating_hours = req.body;
    if (!operating_hours || typeof operating_hours !== 'object') {
      return res.status(400).json({ success: false, message: 'Operating hours object required' });
    }

    const supabase = getSupabase();
    const { data: existing } = await getRestaurant(supabase);
    if (!existing) return res.status(404).json({ success: false, message: 'Restaurant not found' });

    const { data, error } = await supabase
      .from('restaurants')
      .update({ operating_hours })
      .eq('id', existing.id)
      .select('id, operating_hours')
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Update failed', error: error.message });

    res.json({ success: true, message: 'Operating hours updated', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

module.exports = router;
