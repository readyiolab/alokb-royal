// ============================================
// 4. EMAIL SERVICE - OTP Email Template
// ============================================
// email.service.js (Updated)

const nodemailer = require('nodemailer');
const emailConfig = require('../config/email.config');

let transporter = null;

const initTransporter = () => {
  try {
    transporter = nodemailer.createTransport(emailConfig.smtp);
    console.log('Email transporter initialized successfully');
  } catch (error) {
    console.error('Failed to initialize email transporter:', error);
  }
};

initTransporter();

const sendEmail = async (options) => {
  if (!transporter) {
    console.warn('Email transporter not initialized. Skipping email.');
    return { skipped: true };
  }

  try {
    const mailOptions = {
      from: `"${emailConfig.from.name}" <${emailConfig.from.email}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      priority: options.priority || 'normal'
    };

    const result = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully to:', options.to);
    return result;
  } catch (error) {
    console.error('Failed to send email:', error);
    throw new Error('Failed to send email');
  }
};

/**
 * Send 2FA OTP Email
 */
const send2FAOTPEmail = async (email, otp) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Your Login OTP</h2>
      
      <p style="color: #666; font-size: 16px;">Hello,</p>
      
      <p style="color: #666; font-size: 16px;">
        We received a login request for your account. Use the OTP below to complete your login:
      </p>
      
      <div style="background: #f5f5f5; padding: 20px; margin: 20px 0; text-align: center; border-radius: 5px;">
        <p style="margin: 0; font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #2c3e50;">
          ${otp}
        </p>
      </div>
      
      <p style="color: #999; font-size: 14px;">
        <strong>This OTP expires in 5 minutes.</strong>
      </p>
      
      <p style="color: #666; font-size: 14px; margin-top: 20px;">
        If you didn't request this OTP, please ignore this email or contact support immediately.
      </p>
      
      <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
      
      <p style="color: #999; font-size: 12px; text-align: center;">
        Best regards,<br>
        ${emailConfig.from.name}
      </p>
    </div>
  `;

  return sendEmail({
    to: email,
    subject: 'Your Login OTP - Valid for 5 Minutes',
    html,
    priority: 'high'
  });
};

module.exports = {
  initTransporter,
  sendEmail,
  send2FAOTPEmail
};