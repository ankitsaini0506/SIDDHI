require('dotenv').config();
const express     = require('express');
const QRCode      = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const verifyToken = require('../middleware/auth');
const cloudinary  = require('cloudinary').v2;

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Configure cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Shared QR generation helper ───────────────────────────
async function generateAndUploadQR(table) {
  const qr_url = `${process.env.FRONTEND_URL}/menu?table=${table.table_number}`;

  // Generate QR as PNG buffer
  const buffer = await QRCode.toBuffer(qr_url, { width: 400, margin: 2 });

  // Upload buffer to Cloudinary via upload_stream
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder:    'siddhi/qr',
        public_id: `table_${table.table_number}`,
        format:    'png',
        overwrite: true,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });

  return { qr_url, qr_image_url: result.secure_url };
}

// ── GET /api/tables/validate?table=5  (PUBLIC) ────────────
// Must be before /:id routes
router.get('/validate', async (req, res) => {
  try {
    const tableNum = parseInt(req.query.table);
    if (!tableNum) {
      return res.status(400).json({ success: false, message: 'table query param required' });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('tables')
      .select('id, table_number, capacity, location')
      .eq('table_number', tableNum)
      .eq('is_active', true)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or inactive table',
        data: { valid: false },
      });
    }

    res.json({
      success: true,
      message: 'Table is valid',
      data: { valid: true, table_number: data.table_number, table_id: data.id },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/tables/generate-all-qr  (protected) ─────────
// Must be before /:id routes
router.post('/generate-all-qr', verifyToken, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data: tables, error } = await supabase
      .from('tables')
      .select('id, table_number')
      .order('table_number', { ascending: true });

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });
    if (!tables || tables.length === 0) {
      return res.status(404).json({ success: false, message: 'No tables found' });
    }

    const results = [];
    for (const table of tables) {
      try {
        const { qr_url, qr_image_url } = await generateAndUploadQR(table);

        await supabase
          .from('tables')
          .update({ qr_url, qr_image_url })
          .eq('id', table.id);

        results.push({ table_number: table.table_number, qr_url, qr_image_url });
      } catch (qrErr) {
        results.push({ table_number: table.table_number, error: qrErr.message });
      }
    }

    res.json({ success: true, message: 'QR codes generated for all tables', data: results });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/tables  (protected) ─────────────────────────
router.get('/', verifyToken, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('tables')
      .select('id, table_number, capacity, location, qr_url, qr_image_url, is_active, created_at')
      .order('table_number', { ascending: true });

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    res.json({ success: true, message: 'Tables fetched', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/tables  (protected) ────────────────────────
router.post('/', verifyToken, async (req, res) => {
  try {
    const { table_number, capacity, location } = req.body;
    if (!table_number) {
      return res.status(400).json({ success: false, message: 'table_number is required' });
    }

    const supabase = getSupabase();

    // Check for duplicate table_number
    const { data: existing } = await supabase
      .from('tables')
      .select('id')
      .eq('table_number', table_number)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ success: false, message: 'Table number already exists' });
    }

    const qr_url = `${process.env.FRONTEND_URL}/menu?table=${table_number}`;

    const { data, error } = await supabase
      .from('tables')
      .insert({
        table_number: parseInt(table_number),
        capacity:     capacity  ? parseInt(capacity) : 4,
        location:     location  || null,
        qr_url,
        is_active:    true,
      })
      .select('id, table_number, capacity, location, qr_url, qr_image_url, is_active')
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Insert failed', error: error.message });

    res.status(201).json({ success: true, message: 'Table created', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/tables/:id/generate-qr  (protected) ─────────
router.post('/:id/generate-qr', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();

    const { data: table, error: fetchErr } = await supabase
      .from('tables')
      .select('id, table_number')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ success: false, message: 'DB error', error: fetchErr.message });
    if (!table)   return res.status(404).json({ success: false, message: 'Table not found' });

    const { qr_url, qr_image_url } = await generateAndUploadQR(table);

    // Save both qr_url and qr_image_url
    const { error: updateErr } = await supabase
      .from('tables')
      .update({ qr_url, qr_image_url })
      .eq('id', id);

    if (updateErr) return res.status(400).json({ success: false, message: 'Save failed', error: updateErr.message });

    res.json({
      success: true,
      message: 'QR code generated',
      data: { table_number: table.table_number, qr_url, qr_image_url },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PATCH /api/tables/:id/toggle  (protected) ────────────────
router.patch('/:id/toggle', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    if (is_active === undefined)
      return res.status(400).json({ success: false, message: 'is_active field is required' });

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('tables')
      .update({ is_active })
      .eq('id', id)
      .select('id, table_number, is_active')
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Toggle failed', error: error.message });

    res.json({ success: true, message: `Table ${is_active ? 'activated' : 'deactivated'}`, data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PUT /api/tables/:id  (protected) ─────────────────────
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { capacity, location, is_active } = req.body;

    const updates = {};
    if (capacity  !== undefined) updates.capacity  = parseInt(capacity);
    if (location  !== undefined) updates.location  = location;
    if (is_active !== undefined) updates.is_active = is_active;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('tables')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Update failed', error: error.message });

    res.json({ success: true, message: 'Table updated', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── DELETE /api/tables/:id  (protected) ──────────────────
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();

    const { error } = await supabase.from('tables').delete().eq('id', id);
    if (error) return res.status(400).json({ success: false, message: 'Delete failed', error: error.message });

    res.json({ success: true, message: 'Table deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

module.exports = router;
