const fs = require('fs');
const path = require('path');
const { getUploadsDir } = require('../utils/storage');
const { enqueueBatch, getQueueStatus } = require('../services/QueueService');
const DashboardController = require('./DashboardController');

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);

/**
 * Filtra e retorna arquivos de imagem suportados de um diretório.
 * @param {string} dir Caminho absoluto do diretório.
 * @returns {Array<string>} Lista de nomes de arquivos válidos.
 */
function getImageFilesFromDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isFile() && !entry.name.startsWith('.')) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTENSIONS.has(ext)) {
        files.push(entry.name);
      }
    }
  }

  // Ordenação natural dos arquivos (ex: etiqueta-1, etiqueta-2, etiqueta-10)
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return files;
}

class BatchController {
  /**
   * Examina o diretório fornecido pelo usuário e retorna a contagem de itens de imagem.
   */
  static inspectDirectory(req, res) {
    try {
      const { directoryPath } = req.body;

      if (!directoryPath || typeof directoryPath !== 'string' || !directoryPath.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Informe o caminho completo do diretório onde as imagens estão alocadas.'
        });
      }

      const rawPath = directoryPath.trim();
      const resolvedDir = path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(process.cwd(), rawPath);

      if (!fs.existsSync(resolvedDir)) {
        return res.status(404).json({
          success: false,
          message: `O diretório especificado não foi encontrado no servidor: "${resolvedDir}"`
        });
      }

      const stat = fs.statSync(resolvedDir);
      if (!stat.isDirectory()) {
        return res.status(400).json({
          success: false,
          message: `O caminho informado não é uma pasta/diretório: "${resolvedDir}"`
        });
      }

      const imageFiles = getImageFilesFromDir(resolvedDir);

      return res.json({
        success: true,
        data: {
          directory: resolvedDir,
          totalItems: imageFiles.length,
          sampleFiles: imageFiles.slice(0, 8),
          supportedFormats: Array.from(SUPPORTED_EXTENSIONS).join(', ')
        }
      });
    } catch (error) {
      console.error('[LOTE/ERRO] Erro ao examinar diretório:', error.message);
      return res.status(500).json({
        success: false,
        message: `Falha ao acessar o diretório no servidor: ${error.message}`
      });
    }
  }

  /**
   * Confirma o processamento do lote, enfileirando os arquivos na fila FIFO de IA.
   */
  static processBatch(req, res) {
    try {
      const { directoryPath } = req.body;

      if (!directoryPath || typeof directoryPath !== 'string' || !directoryPath.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Informe o caminho do diretório a ser processado.'
        });
      }

      const rawPath = directoryPath.trim();
      const resolvedDir = path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(process.cwd(), rawPath);

      if (!fs.existsSync(resolvedDir)) {
        return res.status(404).json({
          success: false,
          message: `O diretório informado não existe: "${resolvedDir}"`
        });
      }

      const stat = fs.statSync(resolvedDir);
      if (!stat.isDirectory()) {
        return res.status(400).json({
          success: false,
          message: 'O caminho informado não é um diretório válido.'
        });
      }

      const imageFiles = getImageFilesFromDir(resolvedDir);

      if (imageFiles.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Nenhum arquivo de imagem válido (.jpg, .jpeg, .png, .webp, .bmp) foi encontrado neste diretório.'
        });
      }

      const uploadsDir = getUploadsDir();
      const isAlreadyInUploads = path.resolve(resolvedDir) === path.resolve(uploadsDir);
      const enqueuedPaths = [];
      const timestamp = Date.now();

      for (let i = 0; i < imageFiles.length; i++) {
        const fileName = imageFiles[i];
        const sourcePath = path.join(resolvedDir, fileName);

        let finalImagePath = sourcePath;

        // Se o diretório for externo à pasta oficial de uploads, copiamos para uploads
        // Isso preserva as fotos originais do usuário e permite visualização na interface web
        if (!isAlreadyInUploads) {
          const ext = path.extname(fileName);
          const baseName = path.basename(fileName, ext);
          const sanitizedBase = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');
          const destFileName = `lote-${timestamp}-${i + 1}-${sanitizedBase}${ext}`;
          const destPath = path.join(uploadsDir, destFileName);

          try {
            fs.copyFileSync(sourcePath, destPath);
            finalImagePath = destPath;
          } catch (copyErr) {
            console.warn(`[LOTE] Não foi possível copiar ${fileName} para uploads, usando caminho original:`, copyErr.message);
            finalImagePath = sourcePath;
          }
        }

        enqueuedPaths.push(finalImagePath);
      }

      // Adiciona todos os itens na fila única FIFO
      enqueueBatch(enqueuedPaths);

      // Notifica o painel administrativo em tempo real via SSE
      DashboardController.broadcastEvent({ type: 'dashboard-update' });

      return res.json({
        success: true,
        message: `Lote confirmado! ${imageFiles.length} pacote(s) adicionado(s) à fila de processamento.`,
        data: {
          directory: resolvedDir,
          totalItems: imageFiles.length,
          queueStatus: getQueueStatus()
        }
      });
    } catch (error) {
      console.error('[LOTE/ERRO] Erro ao processar lote:', error.message);
      return res.status(500).json({
        success: false,
        message: `Falha ao iniciar o processamento em lote: ${error.message}`
      });
    }
  }

  /**
   * Obtém o status da fila de processamento.
   */
  static getStatus(req, res) {
    return res.json({
      success: true,
      data: getQueueStatus()
    });
  }
}

module.exports = BatchController;
