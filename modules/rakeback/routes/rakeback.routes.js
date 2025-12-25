// modules/rakeback/routes/rakeback.routes.js

const express = require('express');
const router = express.Router();
const rakebackController = require('../controllers/rakeback.controller');
const { verifyToken } = require('../../../middleware/auth.middleware');
const { checkRole } = require('../../../middleware/role.middleware');

// All routes require authentication
router.use(verifyToken);

// Rakeback types
router.get('/types', rakebackController.getRakebackTypes);

// Process rakeback - Admin only
router.post('/', checkRole('admin', 'cashier'), rakebackController.processRakeback);

// Get rakebacks for session
router.get('/session/:sessionId', rakebackController.getRakebacksForSession);

// Get player rakeback history
router.get('/player/:playerId', rakebackController.getPlayerRakebackHistory);

module.exports = router;
