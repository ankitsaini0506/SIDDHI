require('dotenv').config();
const express     = require('express');
const { createClient } = require('@supabase/supabase-js');
const verifyToken = require('../middleware/auth');

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── GET /api/categories  (PUBLIC) ────────────────────────
router.get('/', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    res.json({ success: true, message: 'Categories fetched', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/categories  (protected) ────────────────────
router.post('/', verifyToken, async (req, res) => {
  try {
    const { name, description, sort_order, is_active } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Category name is required' });

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('categories')
      .insert({
        name,
        description: description || null,
        sort_order:  sort_order  ?? 0,
        is_active:   is_active   ?? true,
      })
      .select('id, name, sort_order, is_active')
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Insert failed', error: error.message });

    res.status(201).json({ success: true, message: 'Category created', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PATCH /api/categories/reorder  (protected) ───────────
// NOTE: must be defined BEFORE /:id routes to avoid "reorder" being treated as an id
router.patch('/reorder', verifyToken, async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ success: false, message: 'order array is required' });
    }

    const supabase = getSupabase();
    for (const item of order) {
      await supabase
        .from('categories')
        .update({ sort_order: item.sort_order })
        .eq('id', item.id);
    }

    res.json({ success: true, message: 'Categories reordered' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PUT /api/categories/:id  (protected) ─────────────────
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, sort_order, is_active } = req.body;

    const updates = {};
    if (name        !== undefined) updates.name        = name;
    if (description !== undefined) updates.description = description;
    if (sort_order  !== undefined) updates.sort_order  = sort_order;
    if (is_active   !== undefined) updates.is_active   = is_active;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('categories')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Update failed', error: error.message });

    res.json({ success: true, message: 'Category updated', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── DELETE /api/categories/:id  (protected) ──────────────
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();

    // Check if any menu items belong to this category
    const { count, error: countError } = await supabase
      .from('menu_items')
      .select('*', { count: 'exact', head: true })
      .eq('category_id', id);

    if (countError) return res.status(500).json({ success: false, message: 'DB error', error: countError.message });

    if (count > 0) {
      return res.status(400).json({ success: false, message: 'Remove all items in this category first' });
    }

    const { error } = await supabase.from('categories').delete().eq('id', id);
    if (error) return res.status(400).json({ success: false, message: 'Delete failed', error: error.message });

    res.json({ success: true, message: 'Category deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

module.exports = router;
