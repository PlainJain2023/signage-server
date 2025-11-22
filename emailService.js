/**
 * Email Service - Professional email sending with SendGrid or SMTP
 * Supports SendGrid, Gmail SMTP, custom SMTP, and test mode
 */

const nodemailer = require('nodemailer');
const sgMail = require('@sendgrid/mail');

class EmailService {
  constructor() {
    this.transporter = null;
    this.isConfigured = false;
    this.emailProvider = 'none'; // 'sendgrid', 'smtp', or 'none'
    this.initialize();
  }

  initialize() {
    // Priority 1: Check for SendGrid API key
    const sendgridApiKey = process.env.SENDGRID_API_KEY;

    if (sendgridApiKey) {
      try {
        sgMail.setApiKey(sendgridApiKey);
        this.emailProvider = 'sendgrid';
        this.isConfigured = true;
        console.log('✅ Email service configured: SendGrid');
        return;
      } catch (error) {
        console.error('❌ Failed to configure SendGrid:', error.message);
      }
    }

    // Priority 2: Check for SMTP credentials (Gmail or custom)
    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASS;
    const emailHost = process.env.EMAIL_HOST || 'smtp.gmail.com';
    const emailPort = process.env.EMAIL_PORT || 587;

    if (emailUser && emailPass) {
      try {
        this.transporter = nodemailer.createTransport({
          host: emailHost,
          port: emailPort,
          secure: emailPort === 465, // true for 465, false for other ports
          auth: {
            user: emailUser,
            pass: emailPass
          }
        });

        this.emailProvider = 'smtp';
        this.isConfigured = true;
        console.log('✅ Email service configured: SMTP (Gmail)');
        return;
      } catch (error) {
        console.error('❌ Failed to configure SMTP:', error.message);
      }
    }

    // Priority 3: Test mode (no email service configured)
    console.log('⚠️  Email not configured - verification emails will be logged to console');
    console.log('📧 To enable email sending, add one of these to .env:');
    console.log('');
    console.log('   Option 1 - SendGrid (Recommended):');
    console.log('   SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxx');
    console.log('   EMAIL_FROM=noreply@yourdomain.com');
    console.log('');
    console.log('   Option 2 - Gmail SMTP:');
    console.log('   EMAIL_USER=your-email@gmail.com');
    console.log('   EMAIL_PASS=your-app-password');
    console.log('');
    this.emailProvider = 'none';
    this.isConfigured = false;
  }

  /**
   * Send email verification
   */
  async sendVerificationEmail(email, userName, verificationToken) {
    const verificationUrl = `http://localhost:8100/verify-email?token=${verificationToken}`;

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.8;
            color: #2d3748;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0;
            padding: 20px;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background: white;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
          }
          .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 50px 40px;
            text-align: center;
          }
          .header h1 {
            margin: 0;
            font-size: 36px;
            font-weight: 700;
            text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
          }
          .header p {
            margin: 12px 0 0;
            font-size: 18px;
            opacity: 0.95;
            font-weight: 500;
          }
          .content {
            padding: 50px 40px;
            background: white;
          }
          .content h2 {
            color: #667eea;
            margin: 0 0 25px;
            font-size: 28px;
            font-weight: 700;
          }
          .content p {
            margin: 0 0 18px;
            font-size: 17px;
            line-height: 1.8;
            color: #4a5568;
          }
          .highlight-text {
            color: #2d3748;
            font-weight: 600;
          }
          .button-container {
            text-align: center;
            margin: 35px 0;
          }
          .button {
            display: inline-block;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white !important;
            text-decoration: none;
            padding: 18px 45px;
            border-radius: 10px;
            font-weight: 700;
            font-size: 18px;
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4);
            transition: transform 0.2s, box-shadow 0.2s;
          }
          .button:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.5);
          }
          .token-box {
            background: linear-gradient(135deg, #f7fafc 0%, #edf2f7 100%);
            border: 3px solid #667eea;
            border-radius: 12px;
            padding: 25px;
            margin: 30px 0;
            text-align: center;
          }
          .token-label {
            font-size: 14px;
            color: #718096;
            font-weight: 600;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 1px;
          }
          .token-value {
            font-family: 'Courier New', Consolas, monospace;
            font-size: 22px;
            font-weight: 800;
            color: #667eea;
            letter-spacing: 3px;
            word-break: break-all;
          }
          .info-box {
            background: #fff5f5;
            border-left: 4px solid #fc8181;
            padding: 20px;
            margin: 25px 0;
            border-radius: 6px;
          }
          .info-box p {
            margin: 0;
            color: #742a2a;
            font-size: 15px;
          }
          .link-box {
            background: #f7fafc;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
            word-break: break-all;
          }
          .link-box a {
            color: #667eea;
            text-decoration: none;
            font-size: 14px;
            font-weight: 600;
          }
          .footer {
            background: linear-gradient(135deg, #2d3748 0%, #1a202c 100%);
            color: white;
            padding: 40px;
            text-align: center;
          }
          .footer p {
            margin: 8px 0;
            opacity: 0.9;
          }
          .footer-brand {
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 8px;
          }
          .footer-tagline {
            font-size: 15px;
            opacity: 0.8;
          }
          .footer-copyright {
            margin-top: 20px;
            font-size: 13px;
            opacity: 0.7;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>📱 SmartStick Pro</h1>
            <p>Digital Signage Platform</p>
          </div>

          <div class="content">
            <h2>Welcome, ${userName}! 🎉</h2>

            <p>Thank you for creating an account with <span class="highlight-text">SmartStick Pro</span>. You're just one step away from transforming your digital displays!</p>

            <p class="highlight-text">To complete your registration, please verify your email address:</p>

            <div class="button-container">
              <a href="${verificationUrl}" class="button">
                ✅ Verify Email Address
              </a>
            </div>

            <div class="token-box">
              <div class="token-label">📋 Verification Code</div>
              <div class="token-value">${verificationToken.substring(0, 20)}</div>
            </div>

            <p style="font-size: 15px; color: #718096; margin-top: 20px;">
              <strong>Alternatively,</strong> copy and paste this link into your browser:
            </p>
            <div class="link-box">
              <a href="${verificationUrl}">${verificationUrl}</a>
            </div>

            <div class="info-box">
              <p>⏱️ <strong>Important:</strong> This verification link will expire in 24 hours. Please verify your email soon!</p>
            </div>

            <div style="background: #e6fffa; border-left: 4px solid #38b2ac; padding: 20px; margin: 25px 0; border-radius: 6px;">
              <p style="margin: 0; color: #234e52; font-size: 15px;">
                <strong>💡 Troubleshooting:</strong> If clicking the button doesn't work or your browser shows a security warning, you can manually enter the <strong>Verification Code</strong> shown above in the mobile app by selecting "Enter Code Manually" on the verification screen.
              </p>
            </div>

            <p style="font-size: 15px; color: #a0aec0; margin-top: 30px;">
              If you didn't create an account with SmartStick Pro, you can safely ignore this email.
            </p>
          </div>

          <div class="footer">
            <p class="footer-brand">NextGen Signage</p>
            <p class="footer-tagline">SmartStick Pro - Professional Digital Signage Solution</p>
            <p class="footer-copyright">
              © ${new Date().getFullYear()} NextGen Signage. All rights reserved.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    const textContent = `
Welcome to SmartStick Pro, ${userName}!

Thank you for creating an account. Please verify your email address to complete registration.

Verification Link: ${verificationUrl}

Verification Code: ${verificationToken.substring(0, 20)}

TROUBLESHOOTING: If clicking the link doesn't work or your browser shows a security warning, you can manually enter the Verification Code above in the mobile app by selecting "Enter Code Manually" on the verification screen.

This link will expire in 24 hours.

If you didn't create this account, please ignore this email.

---
NextGen Signage - SmartStick Pro Digital Signage Platform
© ${new Date().getFullYear()} NextGen Signage
    `;

    return this.sendEmail(
      email,
      '✅ Verify Your SmartStick Pro Account',
      textContent,
      htmlContent
    );
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(email, userName, resetToken) {
    const resetUrl = `http://localhost:8100/reset-password?token=${resetToken}`;

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            background-color: #f5f5f5;
            margin: 0;
            padding: 0;
          }
          .container {
            max-width: 600px;
            margin: 40px auto;
            background: white;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }
          .header {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
            padding: 40px 30px;
            text-align: center;
          }
          .header h1 {
            margin: 0;
            font-size: 28px;
            font-weight: 600;
          }
          .content {
            padding: 40px 30px;
          }
          .content p {
            margin: 0 0 20px;
            font-size: 16px;
          }
          .button {
            display: inline-block;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
            text-decoration: none;
            padding: 16px 40px;
            border-radius: 8px;
            font-weight: 600;
            font-size: 16px;
            margin: 20px 0;
            text-align: center;
          }
          .footer {
            background: #f8f9fa;
            padding: 30px;
            text-align: center;
            font-size: 14px;
            color: #666;
            border-top: 1px solid #e9ecef;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔐 Password Reset</h1>
          </div>

          <div class="content">
            <h2 style="color: #f5576c; margin-top: 0;">Reset Your Password</h2>

            <p>Hi ${userName},</p>

            <p>We received a request to reset your password. Click the button below to create a new password:</p>

            <div style="text-align: center;">
              <a href="${resetUrl}" class="button">
                🔑 Reset Password
              </a>
            </div>

            <p style="font-size: 14px; color: #666;">Or copy and paste this link:</p>
            <p style="font-size: 14px; word-break: break-all; color: #f5576c;">${resetUrl}</p>

            <p style="font-size: 14px; color: #666; margin-top: 30px;">
              ⏱️ This link will expire in <strong>1 hour</strong>.
            </p>

            <p style="font-size: 14px; color: #666;">
              If you didn't request a password reset, please ignore this email. Your password will remain unchanged.
            </p>
          </div>

          <div class="footer">
            <p><strong>NextGen Signage</strong></p>
            <p>© ${new Date().getFullYear()} NextGen Signage. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const textContent = `
Password Reset Request

Hi ${userName},

We received a request to reset your password.

Reset Link: ${resetUrl}

This link will expire in 1 hour.

If you didn't request this, please ignore this email.

---
NextGen Signage - SmartStick Pro
© ${new Date().getFullYear()} NextGen Signage
    `;

    return this.sendEmail(
      email,
      '🔐 Reset Your Password - SmartStick Pro',
      textContent,
      htmlContent
    );
  }

  /**
   * Core email sending function
   */
  async sendEmail(to, subject, text, html) {
    // Test mode - log to console
    if (!this.isConfigured) {
      console.log('\n📧 ═══════════════════════════════════════');
      console.log('📧 EMAIL (Test Mode - No Email Service Configured)');
      console.log('📧 ═══════════════════════════════════════');
      console.log(`📧 To: ${to}`);
      console.log(`📧 Subject: ${subject}`);
      console.log('📧 ───────────────────────────────────────');
      console.log(text);
      console.log('📧 ═══════════════════════════════════════\n');
      return { success: true, messageId: 'test-mode', testMode: true };
    }

    try {
      // SendGrid
      if (this.emailProvider === 'sendgrid') {
        const fromEmail = process.env.EMAIL_FROM || 'noreply@smartstickpro.com';
        const fromName = process.env.EMAIL_FROM_NAME || 'SmartStick Pro';

        const msg = {
          to,
          from: {
            email: fromEmail,
            name: fromName
          },
          subject,
          text,
          html,
          trackingSettings: {
            clickTracking: { enable: false },  // DISABLED: Prevents ad blocker issues
            openTracking: { enable: true }      // Keep open tracking (doesn't affect links)
          }
        };

        const response = await sgMail.send(msg);
        console.log(`✅ Email sent via SendGrid to ${to}`);
        return { success: true, messageId: response[0].headers['x-message-id'], provider: 'sendgrid' };
      }

      // SMTP (Gmail or custom)
      if (this.emailProvider === 'smtp') {
        const fromEmail = process.env.EMAIL_FROM || process.env.EMAIL_USER;
        const fromName = process.env.EMAIL_FROM_NAME || 'SmartStick Pro';

        const info = await this.transporter.sendMail({
          from: `"${fromName}" <${fromEmail}>`,
          to,
          subject,
          text,
          html
        });

        console.log(`✅ Email sent via SMTP to ${to}: ${info.messageId}`);
        return { success: true, messageId: info.messageId, provider: 'smtp' };
      }

      throw new Error('Email provider not configured');
    } catch (error) {
      console.error(`❌ Failed to send email to ${to}:`, error.message);
      if (error.response) {
        console.error('SendGrid error response:', error.response.body);
      }
      throw error;
    }
  }
}

// Export singleton instance
module.exports = new EmailService();
