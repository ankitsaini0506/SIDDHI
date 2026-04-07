const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { sendGoogleReviewRequest } = require('./whatsapp');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// ── JOB 1: Auto-cancel stale orders (every 5 min) ────────────
cron.schedule('*/5 * * * *', async () => {
  const supabase = getSupabase();

  // Cancel 1: 'pending' orders older than 5 minutes (legacy flow)
  const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: pending } = await supabase
    .from('orders')
    .select('id, order_number')
    .eq('status', 'pending')
    .lt('created_at', fiveMinsAgo);

  if (pending?.length > 0) {
    await supabase
      .from('orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .in('id', pending.map(o => o.id));
    console.log(`🕐 Auto-cancelled ${pending.length} pending orders (5min)`);
  }

  // Cancel 2: 'requested' orders not reviewed in 10 minutes
  const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: unreviewed } = await supabase
    .from('orders')
    .select('id, order_number')
    .eq('status', 'requested')
    .lt('created_at', tenMinsAgo);

  if (unreviewed?.length > 0) {
    await supabase
      .from('orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .in('id', unreviewed.map(o => o.id));
    console.log(`🕐 Auto-cancelled ${unreviewed.length} unreviewed order requests (10min)`);
  }

  // Cancel 3: 'payment_pending' orders not paid in 15 minutes
  const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: unpaid } = await supabase
    .from('orders')
    .select('id, order_number')
    .eq('status', 'payment_pending')
    .eq('payment_status', 'pending')
    .lt('updated_at', fifteenMinsAgo);

  if (unpaid?.length > 0) {
    await supabase
      .from('orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .in('id', unpaid.map(o => o.id));
    console.log(`🕐 Auto-cancelled ${unpaid.length} unpaid orders (15min timeout)`);
  }
});

// ── JOB 2: Send Google Review WhatsApp 1hr after delivery ─────
cron.schedule('*/5 * * * *', async () => {
  const supabase = getSupabase();
  const now      = new Date().toISOString();

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, order_number, customer_phone, customer_name')
    .eq('status', 'delivered')
    .eq('review_sent', false)
    .not('review_scheduled_at', 'is', null)
    .lte('review_scheduled_at', now);

  if (error) { console.error('[cron review]', error.message); return; }
  if (!orders || orders.length === 0) return;

  const reviewLink = process.env.GOOGLE_REVIEW_LINK || '';

  for (const order of orders) {
    await sendGoogleReviewRequest(order.customer_phone, order.customer_name, reviewLink);

    await supabase
      .from('orders')
      .update({ review_sent: true, updated_at: new Date().toISOString() })
      .eq('id', order.id);

    await supabase.from('notification_logs').insert({
      order_id: order.id,
      type:     'review_request',
      phone:    order.customer_phone,
      message:  `Google review link sent to ${order.customer_name}`,
      status:   'sent',
    });
  }

  console.log(`⭐ Sent review request to ${orders.length} customers`);
});

console.log('⏱️  Cron jobs started: auto-cancel (pending/requested/payment_pending) + review sender (every 5 mins)');

module.exports = {};
