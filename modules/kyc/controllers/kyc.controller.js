// ============================================
// modules/kyc/controllers/kyc.controller.js
// UPDATED WITH DIGILOCKER
// ============================================
const kycService = require('../services/kyc.service');
const { sendSuccess, sendError } = require('../../../utils/response.util');
const { logAudit } = require('../../../utils/logger.util');

class KYCController {
  // ============================================
  // DIGILOCKER KYC ENDPOINTS
  // ============================================

  // Initiate DigiLocker KYC
  async initiateDigiLocker(req, res, next) {
    try {
      const { player_id } = req.params;
      
      const result = await kycService.initiateDigiLockerKYC(player_id, req.user.user_id);
      
      await logAudit(
        req.user.user_id,
        'INITIATE_DIGILOCKER_KYC',
        'tbl_player_kyc',
        player_id,
        null,
        { kyc_id: result.kyc_id },
        req.ip
      );

      return sendSuccess(res, 'DigiLocker KYC initiated. Redirect user to auth_url', result);
    } catch (error) {
      next(error);
    }
  }

  // Handle DigiLocker callback
  async digiLockerCallback(req, res, next) {
    try {
      const { code, state } = req.query;
      
      if (!code || !state) {
        return res.redirect(`${process.env.FRONTEND_URL}/kyc/error?message=Missing+authorization+code`);
      }

      const result = await kycService.handleDigiLockerCallback(code, state);
      
      const aadhaarResult = await kycService.fetchAndStoreAadhaarData(
        result.player_id,
        result.session_id,
        result.player_id
      );

      await logAudit(
        result.player_id,
        'DIGILOCKER_KYC_COMPLETED',
        'tbl_player_kyc',
        result.player_id,
        null,
        aadhaarResult.data,
        req.ip
      );

      return res.redirect(`${process.env.FRONTEND_URL}/kyc/success?player_id=${result.player_id}`);
    } catch (error) {
      console.error('DigiLocker callback error:', error);
      return res.redirect(`${process.env.FRONTEND_URL}/kyc/error?message=${encodeURIComponent(error.message)}`);
    }
  }

  // Fetch PAN data (optional)
  async fetchPANData(req, res, next) {
    try {
      const { player_id, session_id } = req.params;
      
      const panData = await kycService.fetchAndStorePANData(player_id, session_id, req.user.user_id);
      
      return sendSuccess(res, 'PAN data fetched successfully', panData);
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // MANUAL KYC ENDPOINTS
  // ============================================

  // Create KYC record
  async createKYC(req, res, next) {
    try {
      const { player_id } = req.params;
      
      const kycId = await kycService.createKYC(player_id, req.body, req.user.user_id);
      
      await logAudit(
        req.user.user_id,
        'CREATE_KYC',
        'tbl_player_kyc',
        kycId,
        null,
        req.body,
        req.ip
      );

      return sendSuccess(res, 'KYC record created successfully', { kyc_id: kycId }, 201);
    } catch (error) {
      next(error);
    }
  }

  // Get KYC details
  async getKYC(req, res, next) {
    try {
      const { player_id } = req.params;
      
      const kyc = await kycService.getKYC(player_id);
      
      if (!kyc) {
        return sendError(res, 'KYC record not found', 404);
      }

      return sendSuccess(res, 'KYC details retrieved', kyc);
    } catch (error) {
      next(error);
    }
  }

  // Upload KYC document
  async uploadDocument(req, res, next) {
    try {
      const { player_id } = req.params;
      const { document_type } = req.body;
      
      if (!req.file) {
        return sendError(res, 'No file uploaded', 400);
      }

      const filePath = req.file.path;
      
      const uploadResult = await kycService.uploadDocument(player_id, document_type, filePath, req.user.user_id);
      
      await logAudit(
        req.user.user_id,
        'UPLOAD_KYC_DOCUMENT',
        'tbl_player_kyc',
        player_id,
        null,
        { 
          document_type, 
          cloudinary_id: uploadResult.cloudinary_id,
          file_size: uploadResult.file_size
        },
        req.ip
      );

      return sendSuccess(res, 'Document uploaded successfully to Cloudinary', uploadResult);
    } catch (error) {
      next(error);
    }
  }

  // Submit KYC for review
  async submitKYC(req, res, next) {
    try {
      const { player_id } = req.params;
      
      await kycService.submitKYC(player_id, req.user.user_id);
      
      await logAudit(
        req.user.user_id,
        'SUBMIT_KYC',
        'tbl_player_kyc',
        player_id,
        null,
        null,
        req.ip
      );

      return sendSuccess(res, 'KYC submitted successfully for review');
    } catch (error) {
      next(error);
    }
  }

  // Review KYC (Admin)
  async reviewKYC(req, res, next) {
    try {
      const { player_id } = req.params;
      const { action, notes } = req.body;
      
      if (!action || !['approve', 'reject'].includes(action)) {
        return sendError(res, 'Invalid action. Use "approve" or "reject"', 400);
      }

      if (action === 'reject' && !notes) {
        return sendError(res, 'Rejection notes are required', 400);
      }

      await kycService.reviewKYC(player_id, action, notes, req.user.user_id);
      
      await logAudit(
        req.user.user_id,
        `KYC_${action.toUpperCase()}`,
        'tbl_player_kyc',
        player_id,
        null,
        { action, notes },
        req.ip
      );

      return sendSuccess(res, `KYC ${action === 'approve' ? 'approved' : 'rejected'} successfully`);
    } catch (error) {
      next(error);
    }
  }

  // Get pending KYCs (Admin)
  async getPendingKYCs(req, res, next) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      
      const result = await kycService.getPendingKYCs(page, limit);
      
      return sendSuccess(res, 'Pending KYCs retrieved', result);
    } catch (error) {
      next(error);
    }
  }

  // Get all KYCs with filters
  async getAllKYCs(req, res, next) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const filters = {
        kyc_status: req.query.kyc_status,
        kyc_method: req.query.kyc_method,
        search: req.query.search
      };
      
      const result = await kycService.getAllKYCs(filters, page, limit);
      
      return sendSuccess(res, 'KYCs retrieved', result);
    } catch (error) {
      next(error);
    }
  }

  // Register device for push notifications
  async registerDevice(req, res, next) {
    try {
      const { player_id } = req.params;
      
      const deviceId = await kycService.registerDevice(player_id, req.body);
      
      return sendSuccess(res, 'Device registered successfully', { device_id: deviceId }, 201);
    } catch (error) {
      next(error);
    }
  }

  // Get player notifications
  async getNotifications(req, res, next) {
    try {
      const { player_id } = req.params;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      
      const notifications = await kycService.getPlayerNotifications(player_id, page, limit);
      
      return sendSuccess(res, 'Notifications retrieved', notifications);
    } catch (error) {
      next(error);
    }
  }

  // Mark notification as read
  async markNotificationRead(req, res, next) {
    try {
      const { notification_id } = req.params;
      
      await kycService.markNotificationRead(notification_id);
      
      return sendSuccess(res, 'Notification marked as read');
    } catch (error) {
      next(error);
    }
  }

  // Get KYC statistics (Admin)
  async getKYCStats(req, res, next) {
    try {
      const stats = await kycService.getKYCStats();
      
      return sendSuccess(res, 'KYC statistics retrieved', stats);
    } catch (error) {
      next(error);
    }
  }

  // Send manual KYC reminder (Admin)
  async sendManualReminder(req, res, next) {
    try {
      const { player_id } = req.params;
      
      await kycService.sendKYCNotification(
        player_id,
        'kyc_reminder',
        'Complete Your KYC',
        'This is a reminder to complete your KYC verification.'
      );
      
      return sendSuccess(res, 'Reminder sent successfully');
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new KYCController();