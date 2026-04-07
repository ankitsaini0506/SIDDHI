require('dotenv').config();
const express     = require('express');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const verifyToken = require('../middleware/auth');

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── POST /api/auth/login ──────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const supabase = getSupabase();
    const { data: admin, error } = await supabase
      .from('admin')
      .select('id, email, password_hash, restaurant_name, phone')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();

    if (error || !admin) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: admin.id, email: admin.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        admin: {
          id:              admin.id,
          email:           admin.email,
          restaurant_name: admin.restaurant_name,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/auth/profile  (protected) ───────────────────
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data: admin, error } = await supabase
      .from('admin')
      .select('id, email, restaurant_name, phone')
      .eq('id', req.admin.id)
      .maybeSingle();

    if (error || !admin) {
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }

    res.json({ success: true, message: 'Profile fetched', data: admin });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PUT /api/auth/profile  (protected) ───────────────────
router.put('/profile', verifyToken, async (req, res) => {
  try {
    const { restaurant_name, phone, google_review_link } = req.body;
    const supabase = getSupabase();

    const updateAdmin = {};
    if (restaurant_name !== undefined) updateAdmin.restaurant_name = restaurant_name;
    if (phone !== undefined)           updateAdmin.phone = phone;

    const { data: admin, error } = await supabase
      .from('admin')
      .update(updateAdmin)
      .eq('id', req.admin.id)
      .select('id, email, restaurant_name, phone')
      .single();

    if (error) {
      return res.status(400).json({ success: false, message: 'Update failed', error: error.message });
    }

    // Also update restaurant name if provided
    if (restaurant_name) {
      await supabase
        .from('restaurants')
        .update({ name: restaurant_name })
        .limit(1);
    }

    // Update google_review_link on restaurant if provided
    if (google_review_link !== undefined) {
      await supabase
        .from('restaurants')
        .update({ google_review_link })
        .limit(1);
    }

    res.json({ success: true, message: 'Profile updated', data: admin });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PUT /api/auth/change-password  (protected) ───────────
router.put('/change-password', verifyToken, async (req, res) => {
  try {
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password) {
      return res.status(400).json({ success: false, message: 'old_password and new_password are required' });
    }

    const supabase = getSupabase();
    const { data: admin, error } = await supabase
      .from('admin')
      .select('id, password_hash')
      .eq('id', req.admin.id)
      .maybeSingle();

    if (error || !admin) {
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }

    const match = await bcrypt.compare(old_password, admin.password_hash);
    if (!match) {
      return res.status(400).json({ success: false, message: 'Old password is incorrect' });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await supabase
      .from('admin')
      .update({ password_hash: newHash })
      .eq('id', admin.id);

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────
router.post('/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out successfully' });
});

module.exports = router;
