const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const UPLOADS_DIR = process.env.UPLOADS_DIR || 'uploads';

// Resolve o caminho completo de uploads em relação à raiz do projeto se for caminho relativo
const absoluteUploadsDir = path.isAbsolute(UPLOADS_DIR) 
  ? UPLOADS_DIR 
  : path.resolve(__dirname, '..', '..', UPLOADS_DIR);

// Garante que o diretório de uploads existe
if (!fs.existsSync(absoluteUploadsDir)) {
  fs.mkdirSync(absoluteUploadsDir, { recursive: true });
}

// Configuração do Multer para armazenamento de fotos das etiquetas
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, absoluteUploadsDir);
  },
  filename: (req, file, cb) => {
    // Nome único com timestamp e número aleatório
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const rawExt = path.extname(file.originalname || '').toLowerCase();
    const ext = (rawExt && rawExt.length <= 5) ? rawExt : '.jpg';
    cb(null, 'etiqueta-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // Limite seguro de 50MB
  }
});

module.exports = {
  upload,
  getUploadsDir: () => absoluteUploadsDir
};
