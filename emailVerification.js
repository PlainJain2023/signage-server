const crypto = require('crypto');
const { pool } = require('./database');
// Note: For production, install nodemailer: npm install nodemailer
// const nodemailer = require('nodemailer');

// Generate verification token
function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Create verification token for user
async function createVerificationToken(userId, tokenType = 'email') {
  try {
    const token = generateVerificationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const query = `
      INSERT INTO user_verification (user_id, verification_token, token_type, expires_at)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;

    const result = await pool.query(query, [userId, token, tokenType, expiresAt]);
    return result.rows[0];
  } catch (error) {
    console.error('Error creating verification token:', error);
    throw error;
  }
}

// Verify token
async function verifyToken(token) {
  try {
    const query = `
      SELECT * FROM user_verification 
      WHERE verification_token = $1 
        AND expires_at > NOW() 
        AND verified_at IS NULL
    `;

    const result = await pool.query(query, [token]);

    if (result.rows.length === 0) {
      return { valid: false, reason: 'Invalid or expired token' };
    }

    const verification = result.rows[0];

    // Mark as verified
    await pool.query(
      'UPDATE user_verification SET verified_at = NOW() WHERE id = $1',
      [verification.id]
    );

    // Update user email_verified status
    if (verification.token_type === 'email') {
      await pool.query(
        'UPDATE users SET email_verified = TRUE WHERE id = $1',
        [verification.user_id]
      );
    }

    return {
      valid: true,
      userId: verification.user_id,
      tokenType: verification.token_type
    };
  } catch (error) {
    console.error('Error verifying token:', error);
    throw error;
  }
}

// Send verification email (mock for now, implement with real email service later)
async function sendVerificationEmail(email, token, userName) {
  try {
    const verificationUrl = `${process.env.APP_URL || 'https://smartstickpro.com'}/verify-email?token=${token}`;

    // TODO: Implement with nodemailer or SendGrid
    // For now, just log it
    console.log('📧 Verification Email (Mock)');
    console.log('To:', email);
    console.log('Subject: Verify your SmartStick Pro account');
    console.log('Link:', verificationUrl);
    console.log('');
    console.log(`Hi ${userName},`);
    console.log('');
    console.log('Welcome to SmartStick Pro! Please verify your email address by clicking the link below:');
    console.log(verificationUrl);
    console.log('');
    console.log('This link will expire in 24 hours.');
    console.log('');
    console.log('If you did not create this account, please ignore this email.');

    // In production, implement like this:
    /*
    const transporter = nodemailer.createTransporter({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: true,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    await transporter.sendMail({
      from: '"SmartStick Pro" <noreply@smartstickpro.com>',
      to: email,
      subject: 'Verify your SmartStick Pro account',
      html: `
        <h2>Welcome to SmartStick Pro!</h2>
        <p>Hi ${userName},</p>
        <p>Please verify your email address by clicking the button below:</p>
        <a href="${verificationUrl}" style="background-color: #4CAF50; color: white; padding: 14px 20px; text-decoration: none; display: inline-block;">Verify Email</a>
        <p>Or copy and paste this link: ${verificationUrl}</p>
        <p>This link will expire in 24 hours.</p>
        <p>If you did not create this account, please ignore this email.</p>
      `
    });
    */

    return { success: true };
  } catch (error) {
    console.error('Error sending verification email:', error);
    throw error;
  }
}

// Resend verification email
async function resendVerificationEmail(userId) {
  try {
    // Get user info
    const userQuery = 'SELECT email, name, email_verified FROM users WHERE id = $1';
    const userResult = await pool.query(userQuery, [userId]);

    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }

    const user = userResult.rows[0];

    if (user.email_verified) {
      return { success: false, reason: 'Email already verified' };
    }

    // Invalidate old tokens
    await pool.query(
      'UPDATE user_verification SET expires_at = NOW() WHERE user_id = $1 AND token_type = $2',
      [userId, 'email']
    );

    // Create new token
    const verification = await createVerificationToken(userId, 'email');

    // Send email
    await sendVerificationEmail(user.email, verification.verification_token, user.name);

    return { success: true };
  } catch (error) {
    console.error('Error resending verification email:', error);
    throw error;
  }
}

// Check if email is verified
async function isEmailVerified(userId) {
  try {
    const query = 'SELECT email_verified FROM users WHERE id = $1';
    const result = await pool.query(query, [userId]);
    return result.rows[0]?.email_verified || false;
  } catch (error) {
    console.error('Error checking email verification:', error);
    return false;
  }
}

module.exports = {
  generateVerificationToken,
  createVerificationToken,
  verifyToken,
  sendVerificationEmail,
  resendVerificationEmail,
  isEmailVerified
};
