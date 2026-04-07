const Razorpay = require('razorpay');
const crypto   = require('crypto');

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── 1. Create Razorpay order ─────────────────────────────────
// amount MUST be in paise (₹1 = 100 paise)
async function createRazorpayOrder(amountInRupees, receiptId) {
  const order = await razorpay.orders.create({
    amount:   Math.round(amountInRupees * 100),
    currency: 'INR',
    receipt:  receiptId,
    notes:    { restaurant: 'SIDDHI', source: 'QR Order System' },
  });
  return order;
}

// ── 2. Verify payment signature ──────────────────────────────
function verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature) {
  const body     = razorpayOrderId + '|' + razorpayPaymentId;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');
  return expected === razorpaySignature;
}

// ── 3. Initiate refund ───────────────────────────────────────
async function initiateRefund(razorpayPaymentId, amountInRupees, reason) {
  try {
    const refund = await razorpay.payments.refund(razorpayPaymentId, {
      amount: Math.round(amountInRupees * 100),
      notes:  { reason },
    });
    console.log(`✅ Refund initiated: ${refund.id} for ₹${amountInRupees}`);
    return refund;
  } catch (e) {
    console.error(`❌ Refund failed for payment ${razorpayPaymentId}:`, e.message);
    return null;
  }
}

module.exports = { createRazorpayOrder, verifyPaymentSignature, initiateRefund };
