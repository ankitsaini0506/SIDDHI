const { WebSocketServer } = require('ws');

let wss = null;

// ── Initialize WebSocket server attached to an HTTP server ──
function initWebSocket(httpServer) {
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    console.log('[WS] Client connected from', req.socket.remoteAddress);

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  });

  console.log('[WS] WebSocket server ready');
  return wss;
}

// ── Broadcast a typed event to all connected clients ────────
function broadcast(event, data) {
  if (!wss) return;
  const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  });
}

// ── Convenience broadcasters ─────────────────────────────────
const events = {
  newOrder:        (order)  => broadcast('new_order',         order),
  orderUpdated:    (order)  => broadcast('order_updated',     order),
  orderApproved:   (order)  => broadcast('order_approved',    order),
  paymentReceived: (order)  => broadcast('payment_received',  order),
  orderDelivered:  (order)  => broadcast('order_delivered',   order),
};

module.exports = { initWebSocket, broadcast, events };
