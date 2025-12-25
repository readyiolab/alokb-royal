// ============================================
// modules/kyc/routes/kyc.routes.js
// 
// ============================================
const express = require('express');
const router = express.Router();
const kycController = require('../controllers/kyc.controller');
const { verifyToken } = require('../../../middleware/auth.middleware');
const { checkRole } = require('../../../middleware/role.middleware');
const { uploadKYCDocument } = require('../../../middleware/upload.middleware');
const {
  createKYCValidator,
  uploadDocumentValidator,
  reviewKYCValidator,
  registerDeviceValidator
} = require('../validators/kyc.validator');
const { validateRequest } = require('../../../utils/validation.util');

// ============================================
// DIGILOCKER ROUTES (Public for callback)
// ============================================

// Initiate DigiLocker KYC
router.post('/player/:player_id/digilocker/initiate',
  verifyToken,
  checkRole('cashier', 'admin'),
  kycController.initiateDigiLocker
);

// DigiLocker callback (Public - no auth required)
router.get('/digilocker/callback',
  kycController.digiLockerCallback
);

// Fetch PAN data (Optional)
router.post('/player/:player_id/digilocker/:session_id/fetch-pan',
  verifyToken,
  checkRole('cashier', 'admin'),
  kycController.fetchPANData
);

// ============================================
// MANUAL KYC ROUTES
// ============================================

// All other routes require authentication
router.use(verifyToken);

// Player KYC Management
router.post('/player/:player_id/kyc',
  checkRole('cashier', 'admin'),
  createKYCValidator,
  validateRequest,
  kycController.createKYC
);

router.get('/player/:player_id/kyc',
  checkRole('cashier', 'admin'),
  kycController.getKYC
);

router.post('/player/:player_id/kyc/upload',
  checkRole('cashier', 'admin'),
  uploadKYCDocument.single('document'),
  uploadDocumentValidator,
  validateRequest,
  kycController.uploadDocument
);

router.post('/player/:player_id/kyc/submit',
  checkRole('cashier', 'admin'),
  kycController.submitKYC
);

// ============================================
// ADMIN KYC REVIEW ROUTES
// ============================================

router.get('/kyc/pending',
  checkRole('admin'),
  kycController.getPendingKYCs
);

router.get('/kyc/all',
  checkRole('admin'),
  kycController.getAllKYCs
);

router.post('/player/:player_id/kyc/review',
  checkRole('admin'),
  reviewKYCValidator,
  validateRequest,
  kycController.reviewKYC
);

router.get('/kyc/stats',
  checkRole('admin'),
  kycController.getKYCStats
);

// ============================================
// PUSH NOTIFICATION ROUTES
// ============================================

router.post('/player/:player_id/device',
  checkRole('cashier', 'admin'),
  registerDeviceValidator,
  validateRequest,
  kycController.registerDevice
);

router.get('/player/:player_id/notifications',
  checkRole('cashier', 'admin'),
  kycController.getNotifications
);

router.put('/notifications/:notification_id/read',
  checkRole('cashier', 'admin'),
  kycController.markNotificationRead
);

// Manual reminder (Admin)
router.post('/player/:player_id/kyc/remind',
  checkRole('admin'),
  kycController.sendManualReminder
);

module.exports = router;