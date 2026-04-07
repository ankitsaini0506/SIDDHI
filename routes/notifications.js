require('dotenv').config();
const express     = require('express');
const twilio      = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const verifyToken = require('../middleware/auth');
const {
  sendOrderAccepted,
  sendOrderRejected,
  sendGoogleReviewRequest,
} = require('../utils/whatsapp');

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── POST /api/notifications/whatsapp/test  (protected) ────
router.post('/whatsapp/test', verifyToken, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message)
      return res.status(400).json({ success: false, message: 'phone and message are required' });

    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const digits  = String(phone).replace(/\D/g, '');
    const local   = digits.startsWith('91') && digits.length === 12 ? digits.slice(2) : digits;

    const msg = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to:   `whatsapp:+91${local}`,
      body: message,
    });

    res.json({ success: true, message: 'Test WhatsApp sent', data: { message_sid: msg.sid } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'WhatsApp send failed', error: err.message });
  }
});

// ── GET /api/notifications/logs  (protected) ──────────────
router.get('/logs', verifyToken, async (req, res) => {
  try {
    const { type, limit = 50 } = req.query;
    const supabase = getSupabase();

    let query = supabase
      .from('notification_logs')
      .select('id, order_id, type, phone, message, status, sent_at')
      .order('sent_at', { ascending: false })
      .limit(parseInt(limit));

    if (type) query = query.eq('type', type);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    res.json({ success: true, message: 'Notification logs fetched', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/notifications/whatsapp/order-accepted  (protected) ─
router.post('/whatsapp/order-accepted', verifyToken, async (req, res) => {
  try {
    const { order_id, customer_phone, customer_name, estimated_time } = req.body;
    if (!customer_phone || !customer_name)
      return res.status(400).json({ success: false, message: 'customer_phone and customer_name required' });

    const supabase  = getSupabase();
    const { data: order } = await supabase
      .from('orders')
      .select('order_number')
      .eq('id', order_id)
      .maybeSingle();

    const sid = await sendOrderAccepted(
      customer_phone,
      customer_name,
      order ? order.order_number : 'N/A',
      estimated_time || 30
    );

    if (order_id) {
      await supabase.from('notification_logs').insert({
        order_id,
        type:    'order_accepted',
        phone:   customer_phone,
        message: 'Manual order accepted notification sent',
        status:  sid ? 'sent' : 'failed',
      });
    }

    res.json({ success: true, message: 'Order accepted WhatsApp sent', data: { sent: !!sid } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/notifications/whatsapp/order-rejected  (protected) ─
router.post('/whatsapp/order-rejected', verifyToken, async (req, res) => {
  try {
    const { order_id, customer_phone, customer_name, reason } = req.body;
    if (!customer_phone || !customer_name)
      return res.status(400).json({ success: false, message: 'customer_phone and customer_name required' });

    const supabase = getSupabase();
    const { data: order } = await supabase
      .from('orders')
      .select('order_number')
      .eq('id', order_id)
      .maybeSingle();

    const sid = await sendOrderRejected(
      customer_phone,
      customer_name,
      order ? order.order_number : 'N/A',
      reason || 'Unable to process your order'
    );

    if (order_id) {
      await supabase.from('notification_logs').insert({
        order_id,
        type:    'order_rejected',
        phone:   customer_phone,
        message: 'Manual order rejected notification sent',
        status:  sid ? 'sent' : 'failed',
      });
    }

    res.json({ success: true, message: 'Order rejected WhatsApp sent', data: { sent: !!sid } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/notifications/whatsapp/review-request  (protected) ─
router.post('/whatsapp/review-request', verifyToken, async (req, res) => {
  try {
    const { order_id, customer_phone, customer_name, google_review_link } = req.body;
    if (!customer_phone || !customer_name)
      return res.status(400).json({ success: false, message: 'customer_phone and customer_name required' });

    const reviewLink = google_review_link || process.env.GOOGLE_REVIEW_LINK || '';
    const sid = await sendGoogleReviewRequest(customer_phone, customer_name, reviewLink);

    const supabase = getSupabase();
    if (order_id) {
      await supabase.from('notification_logs').insert({
        order_id,
        type:    'review_request',
        phone:   customer_phone,
        message: 'Manual review request sent',
        status:  sid ? 'sent' : 'failed',
      });

      await supabase
        .from('orders')
        .update({ review_sent: true, updated_at: new Date().toISOString() })
        .eq('id', order_id);
    }

    res.json({ success: true, message: 'Review request WhatsApp sent', data: { sent: !!sid } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// ── POST /api/notifications/process-reviews  (protected) ──
router.post('/process-reviews', verifyToken, async (req, res) => {
  try {
    const supabase    = getSupabase();
    const now         = new Date().toISOString();
    const reviewLink  = process.env.GOOGLE_REVIEW_LINK || '';

    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, order_number, customer_phone, customer_name')
      .eq('status', 'delivered')
      .eq('review_sent', false)
      .not('review_scheduled_at', 'is', null)
      .lte('review_scheduled_at', now);

    if (error) return res.status(500).json({ success: false, message: 'DB error', error: error.message });

    let processed_count = 0;
    for (const order of orders || []) {
      const sid = await sendGoogleReviewRequest(order.customer_phone, order.customer_name, reviewLink);

      await supabase
        .from('orders')
        .update({ review_sent: true, updated_at: new Date().toISOString() })
        .eq('id', order.id);

      await supabase.from('notification_logs').insert({
        order_id: order.id,
        type:     'review_request',
        phone:    order.customer_phone,
        message:  `Review request sent for order #${order.order_number}`,
        status:   sid ? 'sent' : 'failed',
      });

      processed_count++;
    }

    res.json({
      success: true,
      message: `Processed ${processed_count} review requests`,
      data: { processed_count },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

module.exports = router;
