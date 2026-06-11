const express = require('express');
const router = express.Router();

// Middlewares
const { upload } = require('./utils/storage');

// Controllers
const PageController = require('./controllers/PageController');
const UploadController = require('./controllers/UploadController');
const DashboardController = require('./controllers/DashboardController');
const PacoteController = require('./controllers/PacoteController');
const AlertaController = require('./controllers/AlertaController');
const ReportController = require('./controllers/ReportController');

// Rotas de Páginas
router.get('/admin', PageController.getAdmin);
router.get('/mobile', PageController.getMobile);
router.get('/', PageController.getHome);

// API Endpoints
router.post('/api/upload', upload.single('etiqueta'), UploadController.uploadSingle);
router.get('/api/events', DashboardController.getEvents);
router.get('/api/dashboard', DashboardController.getDashboard);

// API Pacotes
router.put('/api/pacotes/:id', PacoteController.update);
router.delete('/api/pacotes/:id', PacoteController.delete);
router.get('/api/pacotes/conflito/:codigo', PacoteController.getConflict);
router.get('/api/historico', PacoteController.getHistory);
router.get('/api/clientes', PacoteController.getClients);

// API Alertas
router.post('/api/alertas/:id/confirmar', AlertaController.confirm);
router.delete('/api/alertas/:id', AlertaController.delete);
router.post('/api/alertas/:id/retry', AlertaController.retry);

// API Relatórios
router.get('/api/relatorios/cliente', ReportController.getClientReport);
router.get('/api/relatorios/conferencia', ReportController.getConferenceReport);

module.exports = router;
