function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Returns { allowed: true/false, distance_km: Number }
function checkDeliveryRange(customerLat, customerLng) {
  const lat1 = parseFloat(process.env.RESTAURANT_LAT);
  const lon1 = parseFloat(process.env.RESTAURANT_LNG);
  const lat2 = parseFloat(customerLat);
  const lon2 = parseFloat(customerLng);
  const maxKm = parseFloat(process.env.DELIVERY_RADIUS_KM) || 5;

  const R    = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c        = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return {
    allowed:     distance <= maxKm,
    distance_km: parseFloat(distance.toFixed(2)),
  };
}

module.exports = { checkDeliveryRange };
