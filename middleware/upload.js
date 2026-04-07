const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ALLOWED_FORMATS = ['jpeg', 'jpg', 'png', 'webp'];
const MAX_SIZE_BYTES  = 5 * 1024 * 1024; // 5 MB

// ── Menu image storage ─────────────────────────────────────
const menuStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:           'siddhi/menu',
    allowed_formats:  ALLOWED_FORMATS,
    transformation:   [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }],
  },
});

// ── Logo storage ───────────────────────────────────────────
const logoStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:           'siddhi/logo',
    allowed_formats:  ALLOWED_FORMATS,
    transformation:   [{ width: 400, height: 400, crop: 'limit', quality: 'auto' }],
  },
});

// File type filter — reject non-image files with 400
function fileFilter(_req, file, cb) {
  const ext = file.mimetype.split('/')[1];
  if (ALLOWED_FORMATS.includes(ext)) {
    cb(null, true);
  } else {
    const err = new Error('Only jpeg, jpg, png, webp files are allowed');
    err.status = 400;
    cb(err, false);
  }
}

const uploadMenuImage = multer({
  storage:   menuStorage,
  limits:    { fileSize: MAX_SIZE_BYTES },
  fileFilter,
});

const uploadLogo = multer({
  storage:   logoStorage,
  limits:    { fileSize: MAX_SIZE_BYTES },
  fileFilter,
});

module.exports = { uploadMenuImage, uploadLogo };
