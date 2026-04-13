require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createClient } = require('@supabase/supabase-js');

// ── Env var check ─────────────────────────────────────────
const required = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET',
  'CLOUDINARY_CLOUD_NAME', 'TWILIO_ACCOUNT_SID',
];
required.forEach(key => {
  if (!process.env[key]) console.warn(`⚠️  Missing env var: ${key}`);
});

const app = express();

// ── Middleware ────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://localhost:5174',
  'https://siddhi-website.vercel.app',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(helmet());
app.use(morgan('dev'));

// Webhook needs raw body — must be before express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

// ── Supabase client ───────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Verify DB connection on startup
(async () => {
  const { error } = await supabase.from('admin').select('count', { count: 'exact', head: true });
  if (error) {
    console.error('❌ Supabase connection failed:', error.message);
  } else {
    console.log('✅ Supabase connected');
  }
})();

// ── Health check ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ success: true, status: 'ok', db: 'connected', timestamp: new Date() });
});

// ✅ ADD THIS HERE 👇
app.get("/", (req, res) => {
  res.send("SIDDHI Backend is running 🚀");
});

// ── Routes ────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/restaurant', require('./routes/restaurant'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/tables', require('./routes/tables'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/admin/orders', require('./routes/adminOrders'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/coupons', require('./routes/coupons'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/admin', require('./routes/dashboard'));

// ── 404 handler ───────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ── Global error handler ──────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
});

// ── Start cron jobs ───────────────────────────────────────
require('./utils/cron');

// ── Start server with WebSocket support ───────────────────
const { createServer } = require('http');
const { initWebSocket } = require('./utils/websocket');

const PORT = process.env.PORT || 5000;
const httpServer = createServer(app);
initWebSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`🚀 SIDDHI server running on port ${PORT}`);
  console.log(`🔌 WebSocket ready on ws://localhost:${PORT}`);
});
