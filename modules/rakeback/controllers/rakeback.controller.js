// modules/rakeback/controllers/rakeback.controller.js

const rakebackService = require('../services/rakeback.service');
const { sendSuccess, sendError } = require('../../../utils/response.util');

class RakebackController {
  // Get rakeback types
  async getRakebackTypes(req, res) {
    try {
      const types = await rakebackService.getRakebackTypes();
      sendSuccess(res, 'Rakeback types retrieved', types);
    } catch (error) {
      sendError(res, error.message);
    }
  }

  // Process rakeback
  async processRakeback(req, res) {
    try {
      const result = await rakebackService.processRakeback(req.body, req.user.user_id);
      sendSuccess(res, 'Rakeback processed successfully', result);
    } catch (error) {
      sendError(res, error.message);
    }
  }

  // Get rakebacks for session
  async getRakebacksForSession(req, res) {
    try {
      const rakebacks = await rakebackService.getRakebacksForSession(req.params.sessionId);
      sendSuccess(res, 'Rakebacks retrieved', rakebacks);
    } catch (error) {
      sendError(res, error.message);
    }
  }

  // Get player rakeback history
  async getPlayerRakebackHistory(req, res) {
    try {
      const history = await rakebackService.getPlayerRakebackHistory(req.params.playerId);
      sendSuccess(res, 'Rakeback history retrieved', history);
    } catch (error) {
      sendError(res, error.message);
    }
  }
}

module.exports = new RakebackController();
