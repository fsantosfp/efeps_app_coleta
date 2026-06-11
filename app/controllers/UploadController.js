const path = require('path');
const { enqueueImage } = require('../services/QueueService');

class UploadController {
  static uploadSingle(req, res) {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Nenhuma foto enviada.' });
    }

    const imagePath = req.file.path;
    console.log(`[HTTP] Imagem recebida e gravada: ${path.basename(imagePath)}`);

    // Envia para a fila assíncrona
    enqueueImage(imagePath);

    // Responde imediatamente ao operador de balcão móvel
    res.json({
      success: true,
      message: 'Foto enviada!',
      filename: path.basename(imagePath)
    });
  }
}

module.exports = UploadController;
