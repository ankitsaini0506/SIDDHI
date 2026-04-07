require('dotenv').config();
const express     = require('express');
const { createClient } = require('@supabase/supabase-js');
const verifyToken = require('../middleware/auth');
const { uploadMenuImage } = require('../middleware/upload');
const { deleteFromCloudinary, getPublicIdFromUrl } = require('../utils/cloudinary');

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── GET /api/menu/full  (PUBLIC) ──────────────────────────
// Most important endpoint — must be before /:id
router.get('/full', async (req, res) => {
  try {
    const supabase = getSupabase();

    // Fetch all active categories ordered by sort_order
    const { data: categories, error: catErr } = await supabase
      .from('categories')
      .select('id, name, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (catErr) return res.status(500).json({ success: false, message: 'DB error', error: catErr.message });

    // Fetch all menu items
    const { data: items, error: itemErr } = await supabase
      .from('menu_items')
      .select('id, name, description, price, image_url, is_available, is_veg, variants, tags, preparation_time_mins, category_id')
      .order('name', { ascending: true });

    if (itemErr) return res.status(500).json({ success: false, message: 'DB error', error: itemErr.message });

    // Group items under their category
    const data = categories.map(cat => ({
      ...cat,
      items: items.filter(item => item.category_id === cat.id),
    }));

    res.json({ success: true, message: 'Full menu fetched', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/menu/search?q=paneer  (PUBLIC) ───────────────
router.get('/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q.trim()) return res.status(400).json({ success: false, message: 'Search query q is required' });

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('menu_items')
      .select('*, categories(name)')
      .or(`name.ilike.%${q}%,description.ilike.%${q}%`);

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    res.json({ success: true, message: 'Search results', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/menu/category/:categoryId  (PUBLIC) ──────────
router.get('/category/:categoryId', async (req, res) => {
  try {
    const { categoryId } = req.params;
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('menu_items')
      .select('*')
      .eq('category_id', categoryId)
      .eq('is_available', true)
      .order('name', { ascending: true });

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    res.json({ success: true, message: 'Category items fetched', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/menu  (PUBLIC, with filters) ─────────────────
router.get('/', async (req, res) => {
  try {
    const { veg, available, category } = req.query;
    const supabase = getSupabase();

    let query = supabase
      .from('menu_items')
      .select('*, categories(id, name)');

    if (veg       === 'true')  query = query.eq('is_veg', true);
    if (available === 'true')  query = query.eq('is_available', true);
    if (category)              query = query.eq('category_id', category);

    query = query.order('name', { ascending: true });

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    res.json({ success: true, message: 'Menu items fetched', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/menu  (protected) ───────────────────────────
router.post('/', verifyToken, async (req, res) => {
  try {
    const {
      name, description, category_id, price,
      is_veg, is_available, variants, tags, preparation_time_mins,
    } = req.body;

    if (!name)  return res.status(400).json({ success: false, message: 'name is required' });
    if (!price) return res.status(400).json({ success: false, message: 'price is required' });

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('menu_items')
      .insert({
        name,
        description:           description           || null,
        category_id:           category_id           || null,
        price:                 parseInt(price),
        is_veg:                is_veg                ?? true,
        is_available:          is_available          ?? true,
        variants:              variants              || [],
        tags:                  tags                  || [],
        preparation_time_mins: preparation_time_mins || 15,
      })
      .select('id, name, price, category_id, is_veg, is_available, variants')
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Insert failed', error: error.message });

    res.status(201).json({ success: true, message: 'Menu item created', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/menu/:id/image  (protected + upload) ────────
router.post('/:id/image', verifyToken, uploadMenuImage.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No image file uploaded' });

    // multer-storage-cloudinary puts the secure URL in req.file.path
    const image_url = req.file.path;
    const { id } = req.params;
    const supabase = getSupabase();

    const { error } = await supabase
      .from('menu_items')
      .update({ image_url, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) return res.status(400).json({ success: false, message: 'Image URL save failed', error: error.message });

    res.json({ success: true, message: 'Image uploaded', data: { image_url } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── GET /api/menu/:id  (PUBLIC) ───────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('menu_items')
      .select('*, categories(id, name)')
      .eq('id', id)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });
    if (!data)  return res.status(404).json({ success: false, message: 'Item not found' });

    res.json({ success: true, message: 'Item fetched', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PUT /api/menu/:id  (protected) ───────────────────────
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, category_id, is_veg, preparation_time_mins } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (name                  !== undefined) updates.name                  = name;
    if (description           !== undefined) updates.description           = description;
    if (price                 !== undefined) updates.price                 = parseInt(price);
    if (category_id           !== undefined) updates.category_id           = category_id;
    if (is_veg                !== undefined) updates.is_veg                = is_veg;
    if (preparation_time_mins !== undefined) updates.preparation_time_mins = preparation_time_mins;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('menu_items')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Update failed', error: error.message });

    res.json({ success: true, message: 'Menu item updated', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── PATCH /api/menu/:id/toggle  (protected) ───────────────
router.patch('/:id/toggle', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_available } = req.body;

    if (is_available === undefined) {
      return res.status(400).json({ success: false, message: 'is_available field is required' });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('menu_items')
      .update({ is_available, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, name, is_available')
      .single();

    if (error) return res.status(400).json({ success: false, message: 'Toggle failed', error: error.message });

    res.json({ success: true, message: `Item ${is_available ? 'enabled' : 'disabled'}`, data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── DELETE /api/menu/:id  (protected) ────────────────────
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = getSupabase();

    // Fetch item first to get image_url
    const { data: item, error: fetchErr } = await supabase
      .from('menu_items')
      .select('id, image_url')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ success: false, message: 'DB error', error: fetchErr.message });
    if (!item)    return res.status(404).json({ success: false, message: 'Item not found' });

    // Delete image from Cloudinary if exists
    if (item.image_url) {
      const publicId = getPublicIdFromUrl(item.image_url);
      if (publicId) await deleteFromCloudinary(publicId);
    }

    const { error } = await supabase.from('menu_items').delete().eq('id', id);
    if (error) return res.status(400).json({ success: false, message: 'Delete failed', error: error.message });

    res.json({ success: true, message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

module.exports = router;
