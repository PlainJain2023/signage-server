const crypto = require('crypto');
const { pool } = require('./database');

// Generate unique pairing code
function generatePairingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars (0,O,1,I)
  let code = 'SSP-';
  
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return code; // Format: SSP-XXXX-XXXX-XXXX
}

// Generate device serial number
function generateSerialNumber() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `SSP-${timestamp}${random}`;
}

// Generate verification token
function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Create new device with pairing code
async function createDevice(deviceData = {}) {
  try {
    const serialNumber = deviceData.serialNumber || generateSerialNumber();
    const pairingCode = generatePairingCode();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const query = `
      INSERT INTO displays (
        serial_number, 
        device_name, 
        build_number,
        firmware_version,
        pairing_code, 
        pairing_code_generated_at,
        pairing_code_expires_at,
        is_paired,
        status
      ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, FALSE, 'unpaired')
      RETURNING *
    `;

    const values = [
      serialNumber,
      deviceData.deviceName || 'SmartStick Pro',
      deviceData.buildNumber || '1.0.0',
      deviceData.firmwareVersion || '2025.10.06',
      pairingCode,
      expiresAt
    ];

    const result = await pool.query(query, values);
    return result.rows[0];
  } catch (error) {
    console.error('Error creating device:', error);
    throw error;
  }
}

// Verify pairing code
async function verifyPairingCode(code) {
  try {
    const query = `
      SELECT * FROM displays 
      WHERE pairing_code = $1 
        AND is_paired = FALSE 
        AND pairing_code_expires_at > NOW()
    `;
    
    const result = await pool.query(query, [code.toUpperCase()]);
    
    if (result.rows.length === 0) {
      return { valid: false, reason: 'Invalid, expired, or already used code' };
    }
    
    return { valid: true, device: result.rows[0] };
  } catch (error) {
    console.error('Error verifying pairing code:', error);
    throw error;
  }
}

// Pair device to user
async function pairDeviceToUser(deviceId, userId, location = null) {
  try {
    const query = `
      UPDATE displays 
      SET user_id = $1,
          is_paired = TRUE,
          paired_at = NOW(),
          status = 'offline',
          location = $3,
          pairing_code = NULL,
          pairing_code_expires_at = NULL
      WHERE id = $2 AND is_paired = FALSE
      RETURNING *
    `;
    
    const result = await pool.query(query, [userId, deviceId, location]);
    
    if (result.rows.length === 0) {
      throw new Error('Device not found or already paired');
    }

    // Log activity
    await logDeviceActivity(deviceId, userId, 'paired', null, {
      location: location
    });
    
    return result.rows[0];
  } catch (error) {
    console.error('Error pairing device:', error);
    throw error;
  }
}

// Get device by serial number
async function getDeviceBySerial(serialNumber) {
  try {
    const query = 'SELECT * FROM displays WHERE serial_number = $1';
    const result = await pool.query(query, [serialNumber]);
    return result.rows[0] || null;
  } catch (error) {
    console.error('Error getting device:', error);
    throw error;
  }
}

// Set device status to 'syncing' when pairing starts
async function setDeviceSyncing(deviceId) {
  try {
    const query = `
      UPDATE displays
      SET status = 'syncing',
          updated_at = NOW()
      WHERE id = $1 AND is_paired = FALSE
      RETURNING *
    `;

    const result = await pool.query(query, [deviceId]);
    return result.rows[0] || null;
  } catch (error) {
    console.error('Error setting device to syncing:', error);
    throw error;
  }
}

// Get device by pairing code
async function getDeviceByPairingCode(pairingCode) {
  try {
    const query = 'SELECT * FROM displays WHERE pairing_code = $1';
    const result = await pool.query(query, [pairingCode.toUpperCase()]);
    return result.rows[0] || null;
  } catch (error) {
    console.error('Error getting device by code:', error);
    throw error;
  }
}

// Get user's devices
async function getUserDevices(userId) {
  try {
    const query = `
      SELECT * FROM displays 
      WHERE user_id = $1 AND status != 'revoked'
      ORDER BY paired_at DESC
    `;
    const result = await pool.query(query, [userId]);
    return result.rows;
  } catch (error) {
    console.error('Error getting user devices:', error);
    throw error;
  }
}

// Update device info
async function updateDevice(deviceId, updates) {
  try {
    const { deviceName, location, notes } = updates;

    const query = `
      UPDATE displays
      SET device_name = COALESCE($1, device_name),
          location = COALESCE($2, location),
          notes = COALESCE($3, notes)
      WHERE id = $4
      RETURNING *
    `;

    const result = await pool.query(query, [deviceName, location, notes, deviceId]);
    return result.rows[0];
  } catch (error) {
    console.error('Error updating device:', error);
    throw error;
  }
}

// Update device timezone
async function updateDeviceTimezone(deviceId, timezone) {
  try {
    const query = `
      UPDATE displays
      SET device_timezone = $1
      WHERE id = $2
      RETURNING *
    `;

    const result = await pool.query(query, [timezone, deviceId]);
    return result.rows[0];
  } catch (error) {
    console.error('Error updating device timezone:', error);
    throw error;
  }
}

// Unpair device
async function unpairDevice(deviceId, userId) {
  try {
    // Verify ownership
    const device = await pool.query(
      'SELECT * FROM displays WHERE id = $1 AND user_id = $2',
      [deviceId, userId]
    );
    
    if (device.rows.length === 0) {
      throw new Error('Device not found or not owned by user');
    }

    // Generate new pairing code
    const newPairingCode = generatePairingCode();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    
    const query = `
      UPDATE displays 
      SET user_id = NULL,
          is_paired = FALSE,
          status = 'unpaired',
          pairing_code = $1,
          pairing_code_generated_at = NOW(),
          pairing_code_expires_at = $2,
          socket_id = NULL
      WHERE id = $3
      RETURNING *
    `;
    
    const result = await pool.query(query, [newPairingCode, expiresAt, deviceId]);

    // Log activity
    await logDeviceActivity(deviceId, userId, 'unpaired');
    
    return result.rows[0];
  } catch (error) {
    console.error('Error unpairing device:', error);
    throw error;
  }
}

// Revoke device (permanent removal)
async function revokeDevice(deviceId, userId) {
  try {
    const query = `
      UPDATE displays 
      SET status = 'revoked',
          user_id = NULL,
          is_paired = FALSE,
          pairing_code = NULL
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `;
    
    const result = await pool.query(query, [deviceId, userId]);

    if (result.rows.length === 0) {
      throw new Error('Device not found or not owned by user');
    }

    // Log activity
    await logDeviceActivity(deviceId, userId, 'revoked');
    
    return result.rows[0];
  } catch (error) {
    console.error('Error revoking device:', error);
    throw error;
  }
}

// Update device connection status
async function updateDeviceStatus(deviceId, socketId, status) {
  try {
    const query = `
      UPDATE displays 
      SET socket_id = $1,
          status = $2,
          last_seen = NOW()
      WHERE id = $3
      RETURNING *
    `;
    
    const result = await pool.query(query, [socketId, status, deviceId]);
    return result.rows[0];
  } catch (error) {
    console.error('Error updating device status:', error);
    throw error;
  }
}

// Log pairing attempt
async function logPairingAttempt(pairingCode, ipAddress, userAgent, success, errorMessage = null) {
  try {
    const query = `
      INSERT INTO pairing_attempts (pairing_code, ip_address, user_agent, success, error_message)
      VALUES ($1, $2, $3, $4, $5)
    `;
    
    await pool.query(query, [pairingCode, ipAddress, userAgent, success, errorMessage]);
  } catch (error) {
    console.error('Error logging pairing attempt:', error);
  }
}

// Log device activity
async function logDeviceActivity(deviceId, userId, activityType, ipAddress = null, details = {}) {
  try {
    const query = `
      INSERT INTO device_activity (device_id, user_id, activity_type, ip_address, details)
      VALUES ($1, $2, $3, $4, $5)
    `;
    
    await pool.query(query, [deviceId, userId, activityType, ipAddress, JSON.stringify(details)]);
  } catch (error) {
    console.error('Error logging device activity:', error);
  }
}

// Clean up expired pairing codes
async function cleanupExpiredCodes() {
  try {
    const query = `
      UPDATE displays 
      SET pairing_code = NULL,
          pairing_code_expires_at = NULL
      WHERE pairing_code_expires_at < NOW() 
        AND is_paired = FALSE
      RETURNING serial_number
    `;
    
    const result = await pool.query(query);
    return result.rows.length;
  } catch (error) {
    console.error('Error cleaning up expired codes:', error);
    return 0;
  }
}

module.exports = {
  generatePairingCode,
  generateSerialNumber,
  generateVerificationToken,
  createDevice,
  verifyPairingCode,
  pairDeviceToUser,
  getDeviceBySerial,
  getDeviceByPairingCode,
  getUserDevices,
  updateDevice,
  updateDeviceTimezone,
  unpairDevice,
  revokeDevice,
  updateDeviceStatus,
  setDeviceSyncing,
  logPairingAttempt,
  logDeviceActivity,
  cleanupExpiredCodes
};
