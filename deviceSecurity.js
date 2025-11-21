const crypto = require('crypto');

// Encryption algorithm and key
const ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = process.env.WIFI_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

// Ensure encryption key is 32 bytes
const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), 'hex');

/**
 * Encrypt Wi-Fi password
 * @param {string} text - Plain text password
 * @returns {string} - Encrypted password (format: iv:encryptedData)
 */
function encryptWiFiPassword(text) {
  if (!text) return null;
  
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Return iv:encrypted format
    return `${iv.toString('hex')}:${encrypted}`;
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt Wi-Fi password');
  }
}

/**
 * Decrypt Wi-Fi password
 * @param {string} encryptedText - Encrypted password (format: iv:encryptedData)
 * @returns {string} - Plain text password
 */
function decryptWiFiPassword(encryptedText) {
  if (!encryptedText) return null;
  
  try {
    const [ivHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error('Failed to decrypt Wi-Fi password');
  }
}

/**
 * Validate MAC address format
 * @param {string} macAddress - MAC address to validate
 * @returns {boolean} - True if valid format
 */
function validateMACAddress(macAddress) {
  if (!macAddress) return false;
  
  // Valid formats: XX:XX:XX:XX:XX:XX or XX-XX-XX-XX-XX-XX
  const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
  return macRegex.test(macAddress);
}

/**
 * Normalize MAC address to XX:XX:XX:XX:XX:XX format
 * @param {string} macAddress - MAC address in any format
 * @returns {string} - Normalized MAC address
 */
function normalizeMACAddress(macAddress) {
  if (!macAddress) return null;
  
  // Remove all separators and convert to uppercase
  const cleaned = macAddress.replace(/[:-]/g, '').toUpperCase();
  
  // Add colons every 2 characters
  return cleaned.match(/.{1,2}/g).join(':');
}

module.exports = {
  encryptWiFiPassword,
  decryptWiFiPassword,
  validateMACAddress,
  normalizeMACAddress
};
