const fs = require('fs');
const path = require('path');
const os = require('os');
const { getUploadsDir } = require('../utils/storage');
const { enqueueBatch, getQueueStatus } = require('../services/QueueService');
const DashboardController = require('./DashboardController');

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);

/**
 * Retorna a raiz padrão do sistema operacional (ex: C:\ no Windows, / no Linux e macOS).
 */
function getSystemRoot() {
  if (process.platform === 'win32') {
    const sysDrive = process.env.SystemDrive || 'C:';
    const driveLetter = sysDrive.charAt(0).toUpperCase();
    return driveLetter + ':\\';
  }
  return '/';
}

/**
 * Normaliza e sanitiza o caminho do diretório considerando especificidades de cada SO.
 * @param {string} inputDir Caminho bruto informado.
 * @returns {string} Caminho normalizado.
 */
function normalizeDirPath(inputDir) {
  if (!inputDir || typeof inputDir !== 'string' || !inputDir.trim() || inputDir.trim() === 'root') {
    return getSystemRoot();
  }

  let dir = inputDir.trim();

  // Tratamento específico para Windows: se for apenas a letra da unidade (ex: "C", "C:", "c:")
  if (/^[a-zA-Z]:?$/i.test(dir)) {
    return dir.charAt(0).toUpperCase() + ':\\';
  }

  // Se começou com letra de unidade Windows e barra (ex: "C:/Users" -> "C:\Users")
  if (/^[a-zA-Z]:[\\/]/i.test(dir)) {
    const letter = dir.charAt(0).toUpperCase();
    const rest = dir.substring(2).replace(/\//g, '\\');
    dir = letter + ':' + (rest.startsWith('\\') ? rest : '\\' + rest);
  }

  // Normaliza o caminho
  if (process.platform === 'win32' || /^[a-zA-Z]:/i.test(dir)) {
    dir = path.win32 ? path.win32.normalize(dir) : path.normalize(dir);
    // Garante barra final se for raiz de unidade Windows (ex: "C:\")
    if (/^[a-zA-Z]:\\?$/i.test(dir)) {
      dir = dir.charAt(0).toUpperCase() + ':\\';
    }
  } else {
    dir = path.normalize(dir);
  }

  return dir;
}

/**
 * Determina o diretório pai, retornando null caso já esteja na raiz do sistema.
 */
function getParentDir(dir) {
  if (!dir) return null;

  if (process.platform === 'win32' || /^[a-zA-Z]:/i.test(dir)) {
    // Se for raiz de unidade (ex: "C:\")
    if (/^[a-zA-Z]:\\?$/i.test(dir)) {
      return null;
    }
    const parent = path.win32 ? path.win32.dirname(dir) : path.dirname(dir);
    if (/^[a-zA-Z]:$/i.test(parent)) {
      return parent + '\\';
    }
    return parent === dir ? null : parent;
  }

  if (dir === '/') return null;
  const parent = path.dirname(dir);
  return parent === dir ? null : parent;
}

/**
 * Filtra e retorna arquivos de imagem suportados de um diretório com segurança contra erros de I/O.
 * @param {string} dir Caminho absoluto do diretório.
 * @returns {Array<string>} Lista de nomes de arquivos válidos.
 */
function getImageFilesFromDir(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      try {
        let isFile = false;
        try {
          isFile = entry.isFile();
        } catch (_) {}

        if (isFile && !entry.name.startsWith('.') && !entry.name.startsWith('$')) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.has(ext)) {
            files.push(entry.name);
          }
        }
      } catch (_) {}
    }

    files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    return files;
  } catch (err) {
    console.warn(`[LOTE] Não foi possível ler arquivos de imagem de ${dir}:`, err.message);
    return [];
  }
}

class BatchController {
  /**
   * Lista os diretórios e subdiretórios a partir da raiz do sistema operacional,
   * de forma resiliente contra pastas protegidas (EPERM/EACCES).
   */
  static listDirectories(req, res) {
    try {
      const requestedDir = req.query.dir;
      let targetDir = normalizeDirPath(requestedDir);

      // Se o diretório solicitado não existir, volta para a raiz do SO
      if (!fs.existsSync(targetDir)) {
        targetDir = getSystemRoot();
      }

      // Se for arquivo por engano, pega a pasta pai
      try {
        const stat = fs.statSync(targetDir);
        if (!stat.isDirectory()) {
          targetDir = path.dirname(targetDir);
        }
      } catch (_) {
        targetDir = getSystemRoot();
      }

      // Lê subdiretórios com tratamento seguro contra permissões restritas
      let entries = [];
      let permissionDenied = false;

      try {
        entries = fs.readdirSync(targetDir, { withFileTypes: true });
      } catch (readErr) {
        console.warn(`[LOTE] Acesso restrito em ${targetDir}:`, readErr.message);
        permissionDenied = true;
      }

      const subdirectories = [];
      let imageCountInCurrentDir = 0;

      if (!permissionDenied && Array.isArray(entries)) {
        const isWinPath = process.platform === 'win32' || /^[a-zA-Z]:/i.test(targetDir);

        for (const entry of entries) {
          try {
            const name = entry.name;
            // Ignora pastas/arquivos de sistema ou lixeira do Windows e Unix
            if (name.startsWith('$') || name.startsWith('.')) continue;
            if (['System Volume Information', 'Recovery', 'node_modules'].includes(name)) continue;

            let isDir = false;
            let isFile = false;
            try {
              isDir = entry.isDirectory();
              isFile = entry.isFile();
              // Tratamento para links simbólicos / junções do Windows
              if (!isDir && !isFile && entry.isSymbolicLink()) {
                const linkPath = isWinPath ? path.win32.join(targetDir, name) : path.join(targetDir, name);
                const stat = fs.statSync(linkPath);
                isDir = stat.isDirectory();
                isFile = stat.isFile();
              }
            } catch (_) {}

            if (isDir) {
              const subPath = isWinPath
                ? (path.win32 ? path.win32.join(targetDir, name) : path.join(targetDir, name))
                : path.join(targetDir, name);

              subdirectories.push({
                name,
                path: subPath
              });
            } else if (isFile) {
              const ext = path.extname(name).toLowerCase();
              if (SUPPORTED_EXTENSIONS.has(ext)) {
                imageCountInCurrentDir++;
              }
            }
          } catch (_) {}
        }
      }

      subdirectories.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

      // Lista unidades de disco no Windows (C:\, D:\, E:\, etc.)
      const drives = [];
      if (process.platform === 'win32') {
        for (let i = 65; i <= 90; i++) {
          const letter = String.fromCharCode(i);
          const driveRoot = letter + ':\\';
          try {
            if (fs.existsSync(driveRoot)) {
              drives.push({ label: `Disco Local (${letter}:)`, path: driveRoot, icon: 'hard_drive' });
            }
          } catch (_) {}
        }
      } else {
        drives.push({ label: 'Raiz do Sistema (/)', path: '/', icon: 'storage' });
      }

      // Atalhos de usuário úteis
      const homeDir = os.homedir();
      const userShortcuts = [
        { label: 'Área de Trabalho (Desktop)', path: path.join(homeDir, 'Desktop'), icon: 'desktop_windows' },
        { label: 'Downloads', path: path.join(homeDir, 'Downloads'), icon: 'download' },
        { label: 'Imagens', path: path.join(homeDir, 'Pictures'), icon: 'photo' },
        { label: 'Documentos', path: path.join(homeDir, 'Documents'), icon: 'description' },
        { label: 'Uploads do Sistema', path: getUploadsDir(), icon: 'cloud_upload' },
        { label: 'Pasta do Projeto', path: process.cwd(), icon: 'home' }
      ].filter(s => {
        try {
          return fs.existsSync(s.path);
        } catch (_) {
          return false;
        }
      });

      const parentDir = getParentDir(targetDir);

      return res.json({
        success: true,
        data: {
          currentDir: targetDir,
          parentDir,
          isRoot: parentDir === null,
          systemRoot: getSystemRoot(),
          subdirectories,
          imageCountInCurrentDir,
          drives,
          shortcuts: [...drives, ...userShortcuts],
          permissionDenied
        }
      });
    } catch (error) {
      console.error('[LOTE/ERRO] Erro crítico ao listar diretórios:', error.message);
      return res.status(500).json({
        success: false,
        message: `Falha ao navegar nas pastas: ${error.message}`
      });
    }
  }

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

      const resolvedDir = normalizeDirPath(directoryPath);

      if (!fs.existsSync(resolvedDir)) {
        return res.status(404).json({
          success: false,
          message: `O diretório especificado não foi encontrado: "${resolvedDir}"`
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
          sampleFiles: imageFiles.slice(0, 10),
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
   * Confirma o processamento do lote a partir de uma pasta do disco local, enfileirando na fila FIFO.
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

      const resolvedDir = normalizeDirPath(directoryPath);

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
            console.warn(`[LOTE] Falha ao copiar ${fileName} para uploads, usando original:`, copyErr.message);
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
   * Recebe imagens enviadas diretamente pelo navegador (upload tradicional de formulário HTML via webkitdirectory).
   */
  static uploadBatchFiles(req, res) {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Nenhum arquivo de imagem válido foi recebido.'
        });
      }

      const enqueuedPaths = req.files.map(f => f.path);
      enqueueBatch(enqueuedPaths);

      DashboardController.broadcastEvent({ type: 'dashboard-update' });

      return res.json({
        success: true,
        message: `${enqueuedPaths.length} imagens recebidas e enfileiradas com sucesso!`,
        data: {
          totalItems: enqueuedPaths.length,
          queueStatus: getQueueStatus()
        }
      });
    } catch (error) {
      console.error('[LOTE/ERRO] Erro ao receber upload de lote:', error.message);
      return res.status(500).json({
        success: false,
        message: `Falha ao enviar arquivos: ${error.message}`
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
