const crypto = require('crypto');
const { pool } = require('./database');

// Generate TOTP secret (base32 encoded)
function generateTOTPSecret() {
  const buffer = crypto.randomBytes(20);
  return base32Encode(buffer);
}

// Base32 encoding (for TOTP compatibility with Google Authenticator)
function base32Encode(buffer) {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += base32Chars[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += base32Chars[(value << (5 - bits)) & 31];
  }

  return output;
}

// Base32 decoding
function base32Decode(base32) {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let index = 0;
  const output = Buffer.alloc(Math.ceil(base32.length * 5 / 8));

  for (let i = 0; i < base32.length; i++) {
    const char = base32Chars.indexOf(base32[i].toUpperCase());
    if (char === -1) continue;

    value = (value << 5) | char;
    bits += 5;

    if (bits >= 8) {
      output[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }

  return output.slice(0, index);
}

// Generate TOTP code
function generateTOTP(secret, timeStep = 30) {
  const time = Math.floor(Date.now() / 1000 / timeStep);
  const secretBuffer = base32Decode(secret);
  
  // Create time buffer (8 bytes, big-endian)
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigInt64BE(BigInt(time));
  
  // HMAC-SHA1
  const hmac = crypto.createHmac('sha1', secretBuffer);
  hmac.update(timeBuffer);
  const hash = hmac.digest();
  
  // Dynamic truncation
  const offset = hash[hash.length - 1] & 0xf;
  const code = (
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff)
  ) % 1000000;
  
  return code.toString().padStart(6, '0');
}

// Verify TOTP code
function verifyTOTP(secret, token, window = 1) {
  for (let i = -window; i <= window; i++) {
    const timeStep = Math.floor(Date.now() / 1000 / 30) + i;
    const code = generateTOTP(secret, 30);
    
    if (token === code) {
      return true;
    }
  }
  return false;
}

// Generate backup codes
function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

// Hash backup code for storage
function hashBackupCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

// Enable 2FA for user
async function enable2FA(userId, method = 'totp', phoneNumber = null) {
  try {
    const secret = generateTOTPSecret();
    const backupCodes = generateBackupCodes();
    const hashedBackupCodes = backupCodes.map(hashBackupCode);

    const query = `
      INSERT INTO two_factor_auth (user_id, enabled, method, secret, backup_codes, phone_number, enabled_at)
      VALUES ($1, TRUE, $2, $3, $4, $5, NOW())
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        enabled = TRUE,
        method = $2,
        secret = $3,
        backup_codes = $4,
        phone_number = $5,
        enabled_at = NOW()
      RETURNING id
    `;

    await pool.query(query, [userId, method, secret, hashedBackupCodes, phoneNumber]);

    return {
      secret,
      backupCodes,
      qrCodeData: generateQRCodeData(secret, userId)
    };
  } catch (error) {
    console.error('Error enabling 2FA:', error);
    throw error;
  }
}

// Disable 2FA
async function disable2FA(userId) {
  try {
    const query = `
      UPDATE two_factor_auth 
      SET enabled = FALSE,
          secret = NULL,
          backup_codes = NULL
      WHERE user_id = $1
    `;

    await pool.query(query, [userId]);
    return { success: true };
  } catch (error) {
    console.error('Error disabling 2FA:', error);
    throw error;
  }
}

// Get 2FA settings for user
async function get2FASettings(userId) {
  try {
    const query = 'SELECT * FROM two_factor_auth WHERE user_id = $1';
    const result = await pool.query(query, [userId]);
    return result.rows[0] || null;
  } catch (error) {
    console.error('Error getting 2FA settings:', error);
    throw error;
  }
}

// Verify 2FA token
async function verify2FAToken(userId, token) {
  try {
    const settings = await get2FASettings(userId);
    
    if (!settings || !settings.enabled) {
      return { valid: false, reason: '2FA not enabled' };
    }

    // Check TOTP code
    if (settings.method === 'totp' && settings.secret) {
      const isValid = verifyTOTP(settings.secret, token);
      if (isValid) {
        return { valid: true, method: 'totp' };
      }
    }

    // Check backup codes
    if (settings.backup_codes && settings.backup_codes.length > 0) {
      const hashedToken = hashBackupCode(token);
      const codeIndex = settings.backup_codes.indexOf(hashedToken);
      
      if (codeIndex !== -1) {
        // Remove used backup code
        const updatedCodes = [...settings.backup_codes];
        updatedCodes.splice(codeIndex, 1);
        
        await pool.query(
          'UPDATE two_factor_auth SET backup_codes = $1 WHERE user_id = $2',
          [updatedCodes, userId]
        );
        
        return { valid: true, method: 'backup_code' };
      }
    }

    return { valid: false, reason: 'Invalid code' };
  } catch (error) {
    console.error('Error verifying 2FA token:', error);
    throw error;
  }
}

// Generate QR code data for TOTP setup
function generateQRCodeData(secret, userId) {
  const issuer = 'SmartStick Pro';
  const label = `${issuer}:User${userId}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}

// Check if user has 2FA enabled
async function is2FAEnabled(userId) {
  try {
    const query = 'SELECT enabled FROM two_factor_auth WHERE user_id = $1';
    const result = await pool.query(query, [userId]);
    return result.rows[0]?.enabled || false;
  } catch (error) {
    console.error('Error checking 2FA status:', error);
    return false;
  }
}

// Enable 2FA with an existing secret (for setup verification flow)
async function enableWithSecret(userId, secret) {
  try {
    const backupCodes = generateBackupCodes();
    const hashedBackupCodes = backupCodes.map(hashBackupCode);

    const query = `
      INSERT INTO two_factor_auth (user_id, enabled, method, secret, backup_codes, enabled_at)
      VALUES ($1, TRUE, 'totp', $2, $3, NOW())
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        enabled = TRUE,
        method = 'totp',
        secret = $2,
        backup_codes = $3,
        enabled_at = NOW()
      RETURNING id
    `;

    await pool.query(query, [userId, secret, hashedBackupCodes]);

    return {
      backupCodes
    };
  } catch (error) {
    console.error('Error enabling 2FA with secret:', error);
    throw error;
  }
}

// Generate 2FA secret and QR code (for setup flow)
async function generate2FASecret(userEmail) {
  try {
    const secret = generateTOTPSecret();
    const issuer = 'SmartStick Pro';
    const label = `${issuer}:${userEmail}`;
    const qrCode = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

    return {
      secret,
      qrCode
    };
  } catch (error) {
    console.error('Error generating 2FA secret:', error);
    throw error;
  }
}

module.exports = {
  generateTOTPSecret,
  generateTOTP,
  verifyTOTP,
  generateBackupCodes,
  enable2FA,
  disable2FA,
  get2FASettings,
  verify2FAToken,
  is2FAEnabled,
  generateQRCodeData,
  generate2FASecret,
  enableWithSecret
};
