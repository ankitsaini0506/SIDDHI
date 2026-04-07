const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Delete image from Cloudinary by public_id
async function deleteFromCloudinary(publicId) {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    return result;
  } catch (err) {
    console.error('[Cloudinary] delete error:', err.message);
    return null;
  }
}

// Extract public_id from a Cloudinary URL
// Input:  "https://res.cloudinary.com/demo/image/upload/v1234567890/siddhi/menu/pizza.jpg"
// Output: "siddhi/menu/pizza"
function getPublicIdFromUrl(cloudinaryUrl) {
  try {
    const afterUpload = cloudinaryUrl.split('/upload/')[1]; // "v1234567890/siddhi/menu/pizza.jpg"
    const withoutVersion = afterUpload.replace(/^v\d+\//, '');  // "siddhi/menu/pizza.jpg"
    const withoutExt = withoutVersion.replace(/\.[^/.]+$/, ''); // "siddhi/menu/pizza"
    return withoutExt;
  } catch {
    return null;
  }
}

module.exports = { deleteFromCloudinary, getPublicIdFromUrl };
