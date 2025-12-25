// ============================================
// modules/kyc/services/kyc.service.js
// ============================================
const db = require("../../../config/database");
const { sendSuccess, sendError } = require("../../../utils/response.util");
const { logAudit } = require("../../../utils/logger.util");
const cloudinaryService = require("../../../utils/cloudinary.util");

class KYCService {
  // Step 1: Initiate DigiLocker KYC
  async initiateDigiLockerKYC(playerId, userId) {
    const player = await db.select("tbl_players", "*", "player_id = ?", [
      playerId,
    ]);
    if (!player) {
      throw new Error("Player not found");
    }

    let kyc = await this.getKYC(playerId);

    if (!kyc) {
      const result = await db.insert("tbl_player_kyc", {
        player_id: playerId,
        id_type: "aadhaar",
        id_number: "PENDING",
        kyc_status: "pending",
        kyc_method: "digilocker",
      });
      kyc = { kyc_id: result.insert_id };
    }

    const state = digiLockerService.generateState(playerId);

    await db.insert("tbl_digilocker_sessions", {
      player_id: playerId,
      state: state,
      status: "initiated",
      expires_at: new Date(Date.now() + 15 * 60 * 1000),
    });

    const authURL = digiLockerService.generateAuthURL(state);

    return {
      kyc_id: kyc.kyc_id,
      auth_url: authURL,
      state: state,
    };
  }

  // Step 2: Handle DigiLocker callback
  async handleDigiLockerCallback(code, state) {
    const session = await db.select(
      "tbl_digilocker_sessions",
      "*",
      "state = ? AND status = ?",
      [state, "initiated"]
    );

    if (!session) {
      throw new Error("Invalid or expired DigiLocker session");
    }

    const playerId = session.player_id;

    try {
      const tokenData = await digiLockerService.getAccessToken(code);

      await db.update(
        "tbl_digilocker_sessions",
        {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          token_expires_at: new Date(Date.now() + tokenData.expires_in * 1000),
          status: "authorized",
        },
        "session_id = ?",
        [session.session_id]
      );

      return {
        player_id: playerId,
        session_id: session.session_id,
        access_token: tokenData.access_token,
      };
    } catch (error) {
      await db.update(
        "tbl_digilocker_sessions",
        { status: "failed", error_message: error.message },
        "session_id = ?",
        [session.session_id]
      );
      throw error;
    }
  }

  // Step 3: Fetch and store Aadhaar data
  async fetchAndStoreAadhaarData(playerId, sessionId, userId) {
    const session = await db.select(
      "tbl_digilocker_sessions",
      "*",
      "session_id = ? AND player_id = ? AND status = ?",
      [sessionId, playerId, "authorized"]
    );

    if (!session) {
      throw new Error("DigiLocker session not found or not authorized");
    }

    try {
      const aadhaarData = await digiLockerService.getAadhaarDetails(
        session.access_token
      );

      let photoPath = null;
      if (aadhaarData.photo) {
        const fileName = `player_${playerId}_aadhaar_photo_${Date.now()}.jpg`;
        photoPath = await digiLockerService.savePhotoFromBase64(
          aadhaarData.photo,
          fileName
        );
      }

      const address = `${aadhaarData.address.house}, ${aadhaarData.address.street}, ${aadhaarData.address.locality}, ${aadhaarData.address.dist}, ${aadhaarData.address.state} - ${aadhaarData.address.pincode}`;

      await db.update(
        "tbl_player_kyc",
        {
          id_number: aadhaarData.aadhaar_number,
          photo: photoPath,
          kyc_status: "submitted",
          submitted_at: new Date(),
          digilocker_verified: true,
          digilocker_data: JSON.stringify({
            name: aadhaarData.name,
            dob: aadhaarData.dob,
            gender: aadhaarData.gender,
            address: aadhaarData.address,
          }),
        },
        "player_id = ?",
        [playerId]
      );

      await db.update(
        "tbl_players",
        {
          player_name: aadhaarData.name,
          address: address,
          kyc_status: "submitted",
        },
        "player_id = ?",
        [playerId]
      );

      await db.update(
        "tbl_digilocker_sessions",
        { status: "completed" },
        "session_id = ?",
        [sessionId]
      );

      await this.deactivateReminderSchedule(playerId);

      await this.sendKYCNotification(
        playerId,
        "kyc_submitted",
        "KYC Submitted Successfully",
        "Your KYC has been verified through DigiLocker and submitted for review."
      );

      const kyc = await this.getKYC(playerId);
      await this.logKYCAudit(
        kyc.kyc_id,
        playerId,
        "submitted",
        userId,
        "pending",
        "submitted",
        "DigiLocker verification completed"
      );

      return {
        success: true,
        message: "Aadhaar data fetched and stored successfully",
        data: {
          name: aadhaarData.name,
          aadhaar_number: aadhaarData.aadhaar_number,
          dob: aadhaarData.dob,
        },
      };
    } catch (error) {
      await db.update(
        "tbl_digilocker_sessions",
        { status: "failed", error_message: error.message },
        "session_id = ?",
        [sessionId]
      );
      throw error;
    }
  }

  // Fetch PAN data (optional)
  async fetchAndStorePANData(playerId, sessionId, userId) {
    const session = await db.select(
      "tbl_digilocker_sessions",
      "*",
      "session_id = ? AND player_id = ? AND status IN (?, ?)",
      [sessionId, playerId, "authorized", "completed"]
    );

    if (!session) {
      throw new Error("DigiLocker session not found");
    }

    try {
      const panData = await digiLockerService.getPANDetails(
        session.access_token
      );

      await db.insert("tbl_player_pan_details", {
        player_id: playerId,
        pan_number: panData.pan_number,
        name_on_pan: panData.name,
        dob: panData.dob,
        father_name: panData.father_name,
        verified_via_digilocker: true,
      });

      return panData;
    } catch (error) {
      console.error("Error fetching PAN data:", error);
      throw error;
    }
  }

  // Get KYC details
  async getKYC(playerId) {
    const kyc = await db.select("tbl_player_kyc", "*", "player_id = ?", [
      playerId,
    ]);

    return kyc;
  }

  async createKYC(playerId, data, userId) {
    const result = await db.insert("tbl_player_kyc", {
      player_id: playerId,
      id_type: data.id_type,
      id_number: data.id_number,
      kyc_status: "pending",
      kyc_method: "manual",
    });

    await db.update("tbl_players", { kyc_status: "pending" }, "player_id = ?", [
      playerId,
    ]);

    await this.createReminderSchedule(playerId);
    await this.logKYCAudit(
      result.insert_id,
      playerId,
      "created",
      userId,
      null,
      "pending"
    );

    return result.insert_id;
  }

  // Upload document (Manual KYC)
  async uploadDocument(playerId, documentType, filePath, userId) {
    let kyc = await this.getKYC(playerId);

    // AUTO-CREATE KYC RECORD IF NOT EXISTS (for manual KYC uploads)
    if (!kyc) {
      console.log(`Creating new KYC record for player ${playerId} (manual upload)`);
      const result = await db.insert("tbl_player_kyc", {
        player_id: playerId,
        id_type: "manual",
        id_number: "PENDING",
        kyc_status: "pending",
        kyc_method: "manual"
      });
      kyc = { kyc_id: result.insert_id };
    }

    try {
      // Upload to Cloudinary
      const cloudinaryResult = await cloudinaryService.uploadKYCDocument(
        filePath,
        playerId,
        documentType
      );

      if (!cloudinaryResult.success) {
        throw new Error("Cloudinary upload failed");
      }

      const updateData = {};

      // Store the Cloudinary URL and ID based on document type
      switch (documentType) {
        case "id_front":
          updateData.id_document_front = cloudinaryResult.url;
          updateData.id_document_front_cloudinary_id = cloudinaryResult.cloudinary_id;
          break;
        case "id_back":
          updateData.id_document_back = cloudinaryResult.url;
          updateData.id_document_back_cloudinary_id = cloudinaryResult.cloudinary_id;
          break;
        case "address_proof":
          updateData.address_proof_document = cloudinaryResult.url;
          updateData.address_proof_document_cloudinary_id = cloudinaryResult.cloudinary_id;
          updateData.address_proof_type = "utility_bill";
          break;
        case "photo":
          updateData.photo = cloudinaryResult.url;
          updateData.photo_cloudinary_id = cloudinaryResult.cloudinary_id;
          break;
        default:
          throw new Error("Invalid document type");
      }

      await db.update("tbl_player_kyc", updateData, "player_id = ?", [playerId]);
      
      await this.logKYCAudit(
        kyc.kyc_id,
        playerId,
        "document_uploaded",
        userId,
        null,
        { 
          document_type: documentType,
          cloudinary_id: cloudinaryResult.cloudinary_id,
          file_size: cloudinaryResult.file_size
        },
        `Uploaded ${documentType} to Cloudinary`
      );

      return {
        success: true,
        document_type: documentType,
        url: cloudinaryResult.url,
        cloudinary_id: cloudinaryResult.cloudinary_id,
        file_size: cloudinaryResult.file_size
      };
    } catch (error) {
      console.error(`Error uploading ${documentType}:`, error);
      throw error;
    }
  }

  // Submit KYC for review
  async submitKYC(playerId, userId) {
    const kyc = await this.getKYC(playerId);

    if (!kyc) {
      throw new Error("KYC record not found");
    }

    if (kyc.kyc_method === "digilocker" && kyc.digilocker_verified) {
      throw new Error("DigiLocker KYC is already submitted");
    }

    if (kyc.kyc_method === "manual") {
      if (!kyc.id_document_front || !kyc.photo) {
        throw new Error("Please upload all required documents");
      }
    }

    const now = new Date();

    await db.update(
      "tbl_player_kyc",
      {
        kyc_status: "submitted",
        submitted_at: now,
      },
      "player_id = ?",
      [playerId]
    );

    await db.update(
      "tbl_players",
      {
        kyc_status: "submitted",
      },
      "player_id = ?",
      [playerId]
    );

    await this.deactivateReminderSchedule(playerId);

    await this.sendKYCNotification(
      playerId,
      "kyc_submitted",
      "KYC Submitted",
      "Your KYC documents have been submitted and are under review."
    );

    await this.logKYCAudit(
      kyc.kyc_id,
      playerId,
      "submitted",
      userId,
      "pending",
      "submitted"
    );

    return true;
  }

  // Review KYC
  async reviewKYC(playerId, action, notes, reviewedBy) {
    const kyc = await this.getKYC(playerId);

    if (!kyc) {
      throw new Error("KYC record not found");
    }

    if (kyc.kyc_status !== "submitted" && kyc.kyc_status !== "under_review") {
      throw new Error("KYC must be in submitted or under_review status");
    }

    const now = new Date();
    const updateData = {
      reviewed_at: now,
      reviewed_by: reviewedBy,
    };

    let newStatus;
    let notificationTitle;
    let notificationMessage;

    if (action === "approve") {
      newStatus = "approved";
      updateData.kyc_status = "approved";
      updateData.verified_by = reviewedBy;
      updateData.verified_at = now;
      updateData.verification_notes = notes;

      notificationTitle = "KYC Approved ✓";
      notificationMessage = "Congratulations! Your KYC has been approved.";

      await db.update(
        "tbl_players",
        {
          kyc_status: "approved",
          kyc_completed_at: now,
        },
        "player_id = ?",
        [playerId]
      );
    } else if (action === "reject") {
      newStatus = "rejected";
      updateData.kyc_status = "rejected";
      updateData.rejection_reason = notes;
      updateData.rejection_notes = notes;

      notificationTitle = "KYC Rejected";
      notificationMessage = `Your KYC has been rejected. Reason: ${notes}`;

      await db.update(
        "tbl_players",
        {
          kyc_status: "rejected",
        },
        "player_id = ?",
        [playerId]
      );

      await this.reactivateReminderSchedule(playerId);
    }

    await db.update("tbl_player_kyc", updateData, "player_id = ?", [playerId]);

    await this.sendKYCNotification(
      playerId,
      newStatus === "approved" ? "kyc_approved" : "kyc_rejected",
      notificationTitle,
      notificationMessage
    );

    await this.logKYCAudit(
      kyc.kyc_id,
      playerId,
      newStatus,
      reviewedBy,
      kyc.kyc_status,
      newStatus,
      notes
    );

    return true;
  }

  // Get pending KYCs
  async getPendingKYCs(page = 1, limit = 50) {
    const offset = (page - 1) * limit;

    const kycs = await db.queryAll(
      `SELECT k.*, p.player_code, p.player_name, p.phone_number, p.email,
              CASE WHEN k.kyc_method = 'digilocker' THEN '✓ DigiLocker' ELSE 'Manual' END as verification_method
       FROM tbl_player_kyc k
       INNER JOIN tbl_players p ON k.player_id = p.player_id
       WHERE k.kyc_status IN ('submitted', 'under_review')
       ORDER BY k.digilocker_verified DESC, k.submitted_at ASC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM tbl_player_kyc 
       WHERE kyc_status IN ('submitted', 'under_review')`
    );

    return {
      kycs,
      pagination: {
        total: countResult?.total || 0,
        page,
        limit,
        total_pages: Math.ceil((countResult?.total || 0) / limit),
      },
    };
  }

  // Get all KYCs with filters
  async getAllKYCs(filters = {}, page = 1, limit = 50) {
    const offset = (page - 1) * limit;

    let whereClause = "1=1";
    let params = [];

    if (filters.kyc_status) {
      whereClause += " AND k.kyc_status = ?";
      params.push(filters.kyc_status);
    }

    if (filters.kyc_method) {
      whereClause += " AND k.kyc_method = ?";
      params.push(filters.kyc_method);
    }

    if (filters.search) {
      whereClause +=
        " AND (p.player_name LIKE ? OR p.player_code LIKE ? OR p.phone_number LIKE ?)";
      const searchTerm = `%${filters.search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    const kycs = await db.queryAll(
      `SELECT k.*, p.player_code, p.player_name, p.phone_number, p.email
       FROM tbl_player_kyc k
       INNER JOIN tbl_players p ON k.player_id = p.player_id
       WHERE ${whereClause}
       ORDER BY k.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) as total 
       FROM tbl_player_kyc k
       INNER JOIN tbl_players p ON k.player_id = p.player_id
       WHERE ${whereClause}`,
      params
    );

    return {
      kycs,
      pagination: {
        total: countResult?.total || 0,
        page,
        limit,
        total_pages: Math.ceil((countResult?.total || 0) / limit),
      },
    };
  }

  // Reminder schedule methods
  async createReminderSchedule(playerId) {
    const nextReminder = new Date();
    nextReminder.setDate(nextReminder.getDate() + 1);

    await db.insert("tbl_kyc_reminder_schedule", {
      player_id: playerId,
      next_reminder_scheduled: nextReminder,
      is_active: true,
    });
  }

  async deactivateReminderSchedule(playerId) {
    await db.update(
      "tbl_kyc_reminder_schedule",
      {
        is_active: false,
      },
      "player_id = ?",
      [playerId]
    );
  }

  async reactivateReminderSchedule(playerId) {
    const nextReminder = new Date();
    nextReminder.setDate(nextReminder.getDate() + 1);

    await db.update(
      "tbl_kyc_reminder_schedule",
      {
        is_active: true,
        next_reminder_scheduled: nextReminder,
        reminder_count: 0,
      },
      "player_id = ?",
      [playerId]
    );
  }

  // Send reminders (cron job)
  async sendKYCReminders() {
    const now = new Date();

    const schedules = await db.queryAll(
      `SELECT s.*, p.player_name, p.phone_number, p.email, p.player_code
       FROM tbl_kyc_reminder_schedule s
       INNER JOIN tbl_players p ON s.player_id = p.player_id
       WHERE s.is_active = 1 
       AND s.next_reminder_scheduled <= ?
       AND (s.paused_until IS NULL OR s.paused_until <= ?)
       AND p.kyc_status IN ('not_started', 'pending', 'rejected')`,
      [now, now]
    );

    const remindersSent = [];

    for (const schedule of schedules) {
      try {
        await this.sendKYCNotification(
          schedule.player_id,
          "kyc_reminder",
          "Complete Your KYC",
          `Hi ${schedule.player_name}, please complete your KYC verification using DigiLocker for instant verification.`
        );

        const nextReminder = new Date();
        nextReminder.setDate(nextReminder.getDate() + 1);

        await db.update(
          "tbl_kyc_reminder_schedule",
          {
            last_reminder_sent: now,
            next_reminder_scheduled: nextReminder,
            reminder_count: schedule.reminder_count + 1,
          },
          "schedule_id = ?",
          [schedule.schedule_id]
        );

        remindersSent.push({
          player_id: schedule.player_id,
          player_name: schedule.player_name,
          reminder_count: schedule.reminder_count + 1,
        });
      } catch (error) {
        console.error(
          `Failed to send reminder to player ${schedule.player_id}:`,
          error
        );
      }
    }

    return remindersSent;
  }

  // Notification methods
  async sendKYCNotification(playerId, type, title, message) {
    const notificationId = await db.insert("tbl_kyc_notifications", {
      player_id: playerId,
      notification_type: type,
      notification_title: title,
      notification_message: message,
    });

    const devices = await db.selectAll(
      "tbl_player_devices",
      "*",
      "player_id = ? AND is_active = 1",
      [playerId]
    );

    for (const device of devices) {
      try {
        await this.sendPushNotification(
          device.device_token,
          device.device_type,
          title,
          message
        );

        await db.update(
          "tbl_kyc_notifications",
          {
            push_sent: true,
            push_sent_at: new Date(),
            push_token: device.device_token,
          },
          "notification_id = ?",
          [notificationId.insert_id]
        );
      } catch (error) {
        console.error(
          `Failed to send push to device ${device.device_id}:`,
          error
        );
      }
    }

    return notificationId.insert_id;
  }

  async sendPushNotification(deviceToken, deviceType, title, message) {
    console.log(`Sending push: ${title} - ${message}`);
    return true;
  }

  async registerDevice(playerId, deviceData) {
    const existing = await db.select(
      "tbl_player_devices",
      "device_id",
      "device_token = ?",
      [deviceData.device_token]
    );

    if (existing) {
      await db.update(
        "tbl_player_devices",
        {
          player_id: playerId,
          device_type: deviceData.device_type,
          device_name: deviceData.device_name || null,
          device_model: deviceData.device_model || null,
          is_active: true,
          last_used_at: new Date(),
        },
        "device_id = ?",
        [existing.device_id]
      );

      return existing.device_id;
    }

    const result = await db.insert("tbl_player_devices", {
      player_id: playerId,
      device_token: deviceData.device_token,
      device_type: deviceData.device_type,
      device_name: deviceData.device_name || null,
      device_model: deviceData.device_model || null,
      last_used_at: new Date(),
    });

    return result.insert_id;
  }

  async getPlayerNotifications(playerId, page = 1, limit = 20) {
    const offset = (page - 1) * limit;

    const notifications = await db.queryAll(
      `SELECT * FROM tbl_kyc_notifications 
       WHERE player_id = ? 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [playerId, limit, offset]
    );

    return notifications;
  }

  async markNotificationRead(notificationId) {
    await db.update(
      "tbl_kyc_notifications",
      {
        is_read: true,
        read_at: new Date(),
      },
      "notification_id = ?",
      [notificationId]
    );
  }

  // Audit log
  async logKYCAudit(
    kycId,
    playerId,
    actionType,
    actionBy,
    oldStatus,
    newStatus,
    notes = null
  ) {
    await db.insert("tbl_kyc_audit_log", {
      kyc_id: kycId,
      player_id: playerId,
      action_type: actionType,
      action_by: actionBy,
      old_status: oldStatus,
      new_status: newStatus,
      notes: notes,
    });
  }

  // Statistics
  async getKYCStats() {
    const stats = await db.query(`
      SELECT 
        COUNT(*) as total_kyc,
        SUM(CASE WHEN kyc_status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN kyc_status = 'submitted' THEN 1 ELSE 0 END) as submitted,
        SUM(CASE WHEN kyc_status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN kyc_status = 'rejected' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN kyc_method = 'digilocker' THEN 1 ELSE 0 END) as digilocker_kyc,
        SUM(CASE WHEN kyc_method = 'manual' THEN 1 ELSE 0 END) as manual_kyc
      FROM tbl_player_kyc
    `);

    const playerStats = await db.query(`
      SELECT 
        COUNT(*) as total_players,
        SUM(CASE WHEN kyc_status = 'not_started' THEN 1 ELSE 0 END) as not_started,
        SUM(CASE WHEN kyc_status = 'approved' THEN 1 ELSE 0 END) as kyc_completed
      FROM tbl_players
    `);

    return {
      kyc_stats: stats,
      player_stats: playerStats,
    };
  }
}

module.exports = new KYCService();
