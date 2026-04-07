// Helper: simulate payment for test 11.8
// Usage: node utils/sim_payment.js <order_id>
// Outputs: rzp_order_id|pay_id|signature  (to /tmp/siddhi_sim_pay.txt)
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs     = require('fs');

const orderId = process.argv[2];
if (!orderId) { process.stderr.write('order_id required\n'); process.exit(1); }

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const secret   = process.env.RAZORPAY_KEY_SECRET || 'placeholder';

const rzpId = 'order_SIM_' + Date.now();
const payId = 'pay_SIM_'   + Date.now();
const sig   = crypto.createHmac('sha256', secret).update(rzpId + '|' + payId).digest('hex');

(async () => {
  // Set razorpay_order_id + reset to payment_pending so verify can proceed
  await supabase.from('orders')
    .update({ razorpay_order_id: rzpId, status: 'payment_pending', payment_status: 'pending' })
    .eq('id', orderId);

  fs.writeFileSync('/tmp/siddhi_sim_pay.txt', rzpId + '|' + payId + '|' + sig);
  process.exit(0);
})();
