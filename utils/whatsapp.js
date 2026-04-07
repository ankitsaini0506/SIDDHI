const twilio = require('twilio');

function getClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Normalise phone → always "whatsapp:+91XXXXXXXXXX"
function toWhatsApp(phone) {
  const digits = String(phone).replace(/\D/g, '');
  // Strip leading country code 91 if present (10-digit numbers start with 6-9)
  const local = digits.startsWith('91') && digits.length === 12 ? digits.slice(2) : digits;
  return `whatsapp:+91${local}`;
}

// 1. Order accepted
async function sendOrderAccepted(phone, customerName, orderNumber, estimatedTime) {
  const body =
    `Hi ${customerName}! 🎉 Your order #${orderNumber} at SIDDHI has been accepted ✅\n` +
    `Estimated time: ${estimatedTime} mins 🍽️\n` +
    `Thank you for ordering from us!`;
  return _send(phone, body);
}

// 2. Order rejected
async function sendOrderRejected(phone, customerName, orderNumber, reason) {
  const body =
    `Hi ${customerName}, sorry your order #${orderNumber} could not be accepted ❌\n` +
    `Reason: ${reason}\n` +
    `Please try again or call us directly.`;
  return _send(phone, body);
}

// 3. Google review request (1hr after delivery)
async function sendGoogleReviewRequest(phone, customerName, reviewLink) {
  const body =
    `Hi ${customerName}! 😊 Hope you enjoyed your meal at SIDDHI!\n` +
    `We'd love your feedback — it means a lot to us 🙏\n` +
    `Rate us here: ${reviewLink}`;
  return _send(phone, body);
}

async function _send(phone, body) {
  try {
    const client = getClient();
    const msg = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to:   toWhatsApp(phone),
      body,
    });
    return msg.sid;
  } catch (err) {
    console.error('[WhatsApp] send error:', err.message);
    return null;
  }
}

module.exports = { sendOrderAccepted, sendOrderRejected, sendGoogleReviewRequest };
