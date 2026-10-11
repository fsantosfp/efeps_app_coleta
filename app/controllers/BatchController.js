const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
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

/**
 * Invoca o diálogo nativo do sistema operacional para seleção de pastas.
 */
function openNativeFolderDialog() {
  return new Promise((resolve) => {
    let child;
    const timeout = setTimeout(() => {
      if (child) {
        try { child.kill(); } catch (_) {}
      }
      resolve({ success: false, error: 'Tempo limite esgotado ao aguardar seleção de pasta no sistema operacional.' });
    }, 60000);

    if (process.platform === 'win32') {
      // PowerShell FolderBrowserDialog para Windows
      const psCommand = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Selecione a pasta onde estão as fotos das etiquetas'; $f.ShowNewFolderButton = $false; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }"`;
      child = exec(psCommand, { windowsHide: false }, (err, stdout) => {
        clearTimeout(timeout);
        if (err) return resolve({ success: false, cancelled: true });
        const selected = stdout ? stdout.trim() : '';
        if (selected) {
          resolve({ success: true, selectedPath: selected });
        } else {
          resolve({ success: false, cancelled: true });
        }
      });
    } else if (process.platform === 'darwin') {
      // AppleScript para macOS
      const appleScript = `osascript -e 'POSIX path of (choose folder with prompt "Selecione a pasta onde estão as fotos das etiquetas")'`;
      child = exec(appleScript, (err, stdout) => {
        clearTimeout(timeout);
        if (err) return resolve({ success: false, cancelled: true });
        const selected = stdout ? stdout.trim() : '';
        if (selected) {
          resolve({ success: true, selectedPath: selected });
        } else {
          resolve({ success: false, cancelled: true });
        }
      });
    } else {
      clearTimeout(timeout);
      resolve({ success: false, error: 'Diálogo nativo não suportado neste sistema operacional.' });
    }
  });
}

class BatchController {
  /**
   * Abre a janela nativa do Windows Explorer / macOS Finder para o usuário selecionar uma pasta.
   */
  static async openNativeDialog(req, res) {
    try {
      const result = await openNativeFolderDialog();
      return res.json(result);
    } catch (err) {
      console.error('[LOTE/ERRO] Erro ao abrir diálogo nativo:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  /**
   * Lista os diretórios e subdiretórios para o explorador de pastas visual integrado no portal.
   */
  static listDirectories(req, res) {
    try {
      const requestedDir = req.query.dir;
      let targetDir = requestedDir && requestedDir.trim()
        ? path.resolve(requestedDir.trim())
        : process.cwd();

      if (!fs.existsSync(targetDir)) {
        targetDir = process.cwd();
      }

      const stat = fs.statSync(targetDir);
      if (!stat.isDirectory()) {
        targetDir = path.dirname(targetDir);
      }

      // Lê subdiretórios
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const subdirectories = [];
      let imageCountInCurrentDir = 0;

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        if (entry.isDirectory()) {
          // Ignora pastas do sistema ou lixo
          if (['node_modules', '$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) {
            continue;
          }
          const subPath = path.join(targetDir, entry.name);
          let subImgCount = 0;
          try {
            const subEntries = fs.readdirSync(subPath, { withFileTypes: true });
            for (const sub of subEntries) {
              if (sub.isFile() && !sub.name.startsWith('.')) {
                if (SUPPORTED_EXTENSIONS.has(path.extname(sub.name).toLowerCase())) {
                  subImgCount++;
                }
              }
            }
          } catch (_) {}

          subdirectories.push({
            name: entry.name,
            path: subPath,
            imageCount: subImgCount
          });
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.has(ext)) {
            imageCountInCurrentDir++;
          }
        }
      }

      subdirectories.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

      // Determina diretório pai
      const parsed = path.parse(targetDir);
      const isRoot = parsed.root === targetDir;
      const parentDir = isRoot ? null : path.dirname(targetDir);

      // Atalhos comuns para fácil acesso
      const homeDir = os.homedir();
      const rawShortcuts = [
        { label: 'Pasta do Projeto', path: process.cwd(), icon: 'home' },
        { label: 'Uploads do Sistema', path: getUploadsDir(), icon: 'cloud_upload' },
        { label: 'Área de Trabalho (Desktop)', path: path.join(homeDir, 'Desktop'), icon: 'desktop_windows' },
        { label: 'Downloads', path: path.join(homeDir, 'Downloads'), icon: 'download' },
        { label: 'Imagens', path: path.join(homeDir, 'Pictures'), icon: 'photo' },
        { label: 'Documentos', path: path.join(homeDir, 'Documents'), icon: 'description' }
      ];

      // No Windows, também adiciona as letras das unidades de disco
      const drives = [];
      if (process.platform === 'win32') {
        for (let i = 65; i <= 90; i++) {
          const driveLetter = String.fromCharCode(i) + ':\\';
          try {
            if (fs.existsSync(driveLetter)) {
              drives.push({ label: `Disco (${String.fromCharCode(i)}:)`, path: driveLetter, icon: 'hard_drive' });
            }
          } catch (_) {}
        }
      }

      const shortcuts = [...drives, ...rawShortcuts.filter(s => {
        try {
          return fs.existsSync(s.path);
        } catch (_) {
          return false;
        }
      })];

      return res.json({
        success: true,
        data: {
          currentDir: targetDir,
          parentDir,
          isRoot,
          subdirectories,
          imageCountInCurrentDir,
          shortcuts
        }
      });
    } catch (error) {
      console.error('[LOTE/ERRO] Erro ao listar diretórios:', error.message);
      return res.status(500).json({
        success: false,
        message: `Falha ao navegar nos diretórios: ${error.message}`
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
