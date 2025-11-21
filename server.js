const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const rateLimit = require('express-rate-limit');
const { pool, scheduleDb, uploadDb, displayDb, displayTrackingDb, currentDisplayDb, initializeDatabase } = require('./database');
const { registerUser, loginUser, refreshAccessToken, getUserById, verifyEmail, resendVerificationEmail } = require('./auth');
const { authenticateToken, requireAdmin, optionalAuth } = require('./authMiddleware');
const devicePairing = require('./devicePairing');
const deviceGroups = require('./deviceGroups');
const displaySelectionGroups = require('./displaySelectionGroups');
const twoFactorAuth = require('./twoFactorAuth');
const emailVerification = require('./emailVerification');
const { setupLiveSessionRoutes } = require('./liveSessionRoutes');
const { setupLiveSignaling } = require('./liveSessionSignaling');
const liveSessionDb = require('./liveSessionDb');
const { initializeFirebase } = require('./pushNotifications');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }
});

app.use(cors());
app.use(express.json());

// Rate limiting configuration
// Upload Rate Limiter: 50 uploads per minute, 500 per hour
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 50, // 50 requests per minute
  message: {
    error: 'Too many upload requests. Please wait a moment and try again.',
    retryAfter: 60
  },
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn('⚠️  Rate limit exceeded for upload from IP:', req.ip);
    res.status(429).json({
      error: 'Too many upload requests',
      message: 'Please wait a minute before uploading again',
      retryAfter: 60
    });
  }
});

// Hourly Upload Limiter: 500 uploads per hour
const hourlyUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour window
  max: 500, // 500 requests per hour
  message: {
    error: 'Hourly upload limit reached. Please try again later.',
    retryAfter: 3600
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn('⚠️  Hourly rate limit exceeded for upload from IP:', req.ip);
    res.status(429).json({
      error: 'Hourly upload limit reached',
      message: 'You have exceeded the maximum uploads per hour. Please try again later.',
      retryAfter: 3600
    });
  }
});

// General API Rate Limiter: 100 requests per minute
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 100, // 100 requests per minute
  message: {
    error: 'Too many API requests. Please slow down.',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health checks and Socket.IO
    return req.path === '/health' || req.path.startsWith('/socket.io');
  }
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Image uploads - 10MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Video uploads - 100MB limit
const uploadVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// In-memory tracking (for real-time features only)
let currentContent = null;

// Track connected displays by serial number
// Format: { serialNumber: { socketId, userId, displayName } }
const connectedDisplays = new Map();

// Initialize database and load current content on startup
initializeDatabase()
  .then(async () => {
    // Load persisted current display from database
    const savedDisplay = await currentDisplayDb.get();
    if (savedDisplay) {
      const now = new Date();
      const clearAt = new Date(savedDisplay.clear_at);
      
      // Only restore if not expired
      if (clearAt > now) {
        currentContent = {
          type: 'image',
          url: savedDisplay.image_url,
          rotation: savedDisplay.rotation,
          mirror: savedDisplay.mirror,
          duration: savedDisplay.duration,
          displayedAt: new Date(savedDisplay.displayed_at),
          clearAt: clearAt
        };
        console.log('✅ Restored current display from database:', savedDisplay.image_url);
      } else {
        // Expired - clear from database
        await currentDisplayDb.clear();
        console.log('ℹ️  Previous display expired, cleared from database');
      }
    }
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

// ============================================
// AUTHENTICATION ROUTES
// ============================================

// Register new user
app.post('/api/auth/register', apiLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body;

    // Validation
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Register user
    const result = await registerUser(email, password, name);

    console.log('✅ User registered:', email);
    res.status(201).json(result);
  } catch (error) {
    console.error('Registration failed:', error);
    if (error.message === 'User already exists') {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login user
app.post('/api/auth/login', apiLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await loginUser(email, password);

    console.log('✅ User logged in:', email);
    res.json(result);
  } catch (error) {
    console.error('Login failed:', error);

    // Handle email not verified error specially
    if (error.code === 'EMAIL_NOT_VERIFIED') {
      return res.status(403).json({
        error: 'Email not verified',
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email address before logging in.',
        email: error.email
      });
    }

    res.status(401).json({ error: 'Invalid email or password' });
  }
});

// Refresh access token
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    const result = await refreshAccessToken(refreshToken);
    res.json(result);
  } catch (error) {
    console.error('Token refresh failed:', error);
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// Verify email with token
app.get('/api/auth/verify-email', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: 'Verification token required' });
    }

    const result = await verifyEmail(token);

    console.log('✅ Email verified:', result.user.email);
    res.json(result);
  } catch (error) {
    console.error('Email verification failed:', error);
    res.status(400).json({
      error: error.message || 'Email verification failed',
      code: 'VERIFICATION_FAILED'
    });
  }
});

// Resend verification email
app.post('/api/auth/resend-verification', apiLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const result = await resendVerificationEmail(email);

    console.log('✅ Verification email resent to:', email);
    res.json(result);
  } catch (error) {
    console.error('Resend verification failed:', error);
    res.status(400).json({
      error: error.message || 'Failed to resend verification email'
    });
  }
});

// Get current user info
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get user info with subscription details
    const result = await pool.query(`
      SELECT
        u.id, u.email, u.name, u.role, u.account_id, u.created_at, u.last_login, u.is_active,
        u.subscription_tier, u.subscription_status, u.subscription_started_at,
        u.subscription_renews_at, u.storage_used_bytes
      FROM users u
      WHERE u.id = $1
    `, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Get tier features
    const { getTierFeatures, formatBytes } = require('./middleware/tierCheck');
    const tierInfo = getTierFeatures(user.subscription_tier || 'basic');

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        account_id: user.account_id,
        created_at: user.created_at,
        last_login: user.last_login,
        is_active: user.is_active,
        subscription: {
          tier: user.subscription_tier || 'basic',
          status: user.subscription_status || 'active',
          startedAt: user.subscription_started_at,
          renewsAt: user.subscription_renews_at,
          tierName: tierInfo.name,
          tierPrice: tierInfo.price,
          features: tierInfo.features,
          limits: tierInfo.limits,
          storage: {
            used: user.storage_used_bytes || 0,
            usedFormatted: formatBytes(user.storage_used_bytes || 0),
            limit: tierInfo.limits.storage
          }
        }
      }
    });
  } catch (error) {
    console.error('Get user failed:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// Change email
app.post('/api/auth/change-email', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { newEmail, password } = req.body;
    const userId = req.user.userId;

    if (!newEmail || !password) {
      return res.status(400).json({ error: 'New email and password are required' });
    }

    // Verify password first
    const { loginUser } = require('./auth');
    const user = await getUserById(userId);
    
    try {
      await loginUser(user.email, password);
    } catch (error) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    // Update email
    const { updateUser } = require('./auth');
    await updateUser(userId, { email: newEmail });

    console.log('✅ Email changed for user:', userId);
    res.json({ success: true, message: 'Email updated successfully' });
  } catch (error) {
    console.error('Email change failed:', error);
    if (error.message && error.message.includes('duplicate')) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    res.status(500).json({ error: 'Failed to change email' });
  }
});

// Change name
app.post('/api/auth/change-name', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { newName } = req.body;
    const userId = req.user.userId;

    if (!newName || !newName.trim()) {
      return res.status(400).json({ error: 'New name is required' });
    }

    if (newName.length < 2) {
      return res.status(400).json({ error: 'Name must be at least 2 characters' });
    }

    // Update name
    const { updateUser } = require('./auth');
    await updateUser(userId, { name: newName });

    console.log('✅ Name changed for user:', userId);
    res.json({ success: true, message: 'Name updated successfully' });
  } catch (error) {
    console.error('Name change failed:', error);
    res.status(500).json({ error: 'Failed to change name' });
  }
});

// Change password
app.post('/api/auth/change-password', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.userId;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // Change password
    const { changePassword } = require('./auth');
    await changePassword(userId, currentPassword, newPassword);

    console.log('✅ Password changed for user:', userId);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Password change failed:', error);
    if (error.message === 'Current password is incorrect') {
      return res.status(401).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Verify password (for sensitive operations like enabling 2FA)
app.post('/api/auth/verify-password', authenticateToken, async (req, res) => {
  try {
    const { password } = req.body;
    const userId = req.user.userId;

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    // Verify password
    const { verifyUserPassword } = require('./auth');
    const isValid = await verifyUserPassword(userId, password);

    if (!isValid) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    res.json({ success: true, message: 'Password verified' });
  } catch (error) {
    console.error('Password verification failed:', error);
    res.status(500).json({ error: 'Failed to verify password' });
  }
});

// Logout (client-side handles token removal, this is just for logging)
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Clear any pending schedules for this user
    try {
      await pool.query('DELETE FROM schedules WHERE user_id = $1 AND status = \'pending\'', [userId]);
      console.log('✅ Cleared pending schedules for user:', userId);
    } catch (error) {
      console.error('⚠️  Failed to clear schedules:', error);
    }
    
    // Clear current display if it belongs to this user
    try {
      await currentDisplayDb.clear();
      currentContent = null;
      io.emit('clear-content');
      console.log('✅ Cleared current display for logout');
    } catch (error) {
      console.error('⚠️  Failed to clear display:', error);
    }
    
    console.log('👋 User logged out:', req.user.email);
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.json({ success: true, message: 'Logged out successfully' });
  }
});

// Clear all user data (schedules, uploads, display history)
app.post('/api/auth/clear-data', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Clear schedules
    await pool.query('DELETE FROM schedules WHERE user_id = $1', [userId]);
    
    // Clear current display
    await currentDisplayDb.clear();
    currentContent = null;
    io.emit('clear-content');
    
    console.log('🗑️ Cleared all data for user:', userId);
    res.json({ success: true, message: 'All data cleared successfully' });
  } catch (error) {
    console.error('Failed to clear user data:', error);
    res.status(500).json({ error: 'Failed to clear data' });
  }
});

// ============================================
// DEVICE PAIRING ROUTES (Phase 2.2)
// ============================================

// Generate pairing code (for display devices)
app.post('/api/devices/generate-pairing-code', apiLimiter, async (req, res) => {
  try {
    const { serialNumber } = req.body;
    
    if (!serialNumber) {
      return res.status(400).json({ error: 'Serial number required' });
    }

    console.log('🔑 Pairing code request for serial:', serialNumber);

    // Check if device already exists
    const existingDevice = await devicePairing.getDeviceBySerial(serialNumber);
    
    if (existingDevice) {
      console.log('📱 Device already exists:', serialNumber, 'status:', existingDevice.status);
      
      // If device exists and is unpaired, generate new pairing code
      if (!existingDevice.is_paired) {
        const newPairingCode = devicePairing.generatePairingCode();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        
        const updateQuery = `
          UPDATE displays 
          SET pairing_code = $1,
              pairing_code_generated_at = NOW(),
              pairing_code_expires_at = $2,
              status = 'unpaired'
          WHERE serial_number = $3
          RETURNING *
        `;
        
        const result = await pool.query(updateQuery, [newPairingCode, expiresAt, serialNumber]);
        const device = result.rows[0];
        
        console.log('✅ Updated existing device with new pairing code:', serialNumber);
        
        return res.status(200).json({
          success: true,
          pairingCode: device.pairing_code,
          serialNumber: device.serial_number,
          expiresAt: device.pairing_code_expires_at
        });
      } else {
        // Device is already paired
        console.log('⚠️ Device already paired:', serialNumber);
        return res.status(400).json({ 
          error: 'Device already paired',
          message: 'This device is already paired to a user account'
        });
      }
    }

    // Device doesn't exist - create new one
    console.log('🆕 Creating new device:', serialNumber);
    const device = await devicePairing.createDevice({
      serialNumber,
      deviceName: 'SmartStick Pro',
      buildNumber: 'v1.0.0',
      firmwareVersion: '1.0.0'
    });
    
    console.log('✅ Pairing code generated for:', serialNumber);
    
    res.status(200).json({
      success: true,
      pairingCode: device.pairing_code,
      serialNumber: device.serial_number,
      expiresAt: device.pairing_code_expires_at
    });
  } catch (error) {
    console.error('❌ Pairing code generation failed:', error);
    console.error('Error details:', error.message);
    res.status(500).json({ 
      error: 'Failed to generate pairing code',
      message: error.message 
    });
  }
});

// Check pairing status
app.get('/api/devices/pairing-status/:serialNumber', apiLimiter, async (req, res) => {
  try {
    const { serialNumber } = req.params;
    const device = await devicePairing.getDeviceBySerial(serialNumber);
    
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    console.log('🔍 Pairing status check for', serialNumber, '- is_paired:', device.is_paired, 'status:', device.status);
    
    res.json({
      success: true,
      isPaired: device.is_paired, // ✅ FIX: Check is_paired flag, not status field
      status: device.status,
      userId: device.user_id // Include user_id for debugging
    });
  } catch (error) {
    console.error('Failed to check pairing status:', error);
    res.status(500).json({ error: 'Failed to check pairing status' });
  }
});

// Get device info by serial number (for display identification)
app.get('/api/devices/info/:serialNumber', apiLimiter, async (req, res) => {
  try {
    const { serialNumber } = req.params;
    const device = await devicePairing.getDeviceBySerial(serialNumber);
    
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    console.log('📱 Device info request for:', serialNumber);
    
    res.json({
      success: true,
      serial_number: device.serial_number,
      device_name: device.device_name || device.serial_number,
      build_number: device.build_number,
      firmware_version: device.firmware_version,
      is_paired: device.is_paired,
      status: device.status
    });
  } catch (error) {
    console.error('Failed to get device info:', error);
    res.status(500).json({ error: 'Failed to get device info' });
  }
});

// Create new device (for manufacturing/setup)
app.post('/api/devices/create', apiLimiter, async (req, res) => {
  try {
    const device = await devicePairing.createDevice(req.body);
    console.log('✅ Device created:', device.serial_number);
    res.status(201).json({
      success: true,
      device: {
        serialNumber: device.serial_number,
        pairingCode: device.pairing_code,
        expiresAt: device.pairing_code_expires_at
      }
    });
  } catch (error) {
    console.error('Device creation failed:', error);
    res.status(500).json({ error: 'Failed to create device' });
  }
});

// Verify pairing code
app.post('/api/devices/verify-code', apiLimiter, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Pairing code required' });
    }

    const result = await devicePairing.verifyPairingCode(code);

    // Log attempt
    await devicePairing.logPairingAttempt(
      code,
      req.ip,
      req.headers['user-agent'],
      result.valid,
      result.reason
    );

    if (!result.valid) {
      return res.status(400).json({ error: result.reason });
    }

    // ✨ NEW: Set device status to 'syncing' to trigger "Pairing in Progress" state on display
    await devicePairing.setDeviceSyncing(result.device.id);
    console.log('🔄 Device status set to "syncing" for:', result.device.serial_number);

    res.json({
      success: true,
      device: {
        id: result.device.id,
        serialNumber: result.device.serial_number,
        deviceName: result.device.device_name
      }
    });
  } catch (error) {
    console.error('Code verification failed:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Pair device to user (during registration OR adding additional device)
app.post('/api/devices/pair', authenticateToken, async (req, res) => {
  try {
    const { deviceId, pairingCode, location } = req.body;
    const userId = req.user.userId;

    console.log('📱 /api/devices/pair request:', {
      userId,
      hasDeviceId: !!deviceId,
      hasPairingCode: !!pairingCode,
      pairingCode: pairingCode || 'none',
      location: location || 'none'
    });

    let finalDeviceId = deviceId;

    // If pairing code is provided instead of deviceId, verify and get device
    if (pairingCode && !deviceId) {
      console.log('🔍 Pairing code provided, verifying:', pairingCode);

      const result = await devicePairing.verifyPairingCode(pairingCode);

      console.log('🔍 Verification result:', {
        valid: result.valid,
        reason: result.reason,
        deviceId: result.device?.id,
        serialNumber: result.device?.serial_number
      });

      if (!result.valid) {
        console.error('❌ Invalid pairing code:', result.reason);
        return res.status(400).json({ error: result.reason });
      }

      finalDeviceId = result.device.id;
      console.log('✅ Pairing code verified, device ID:', finalDeviceId);

      // Set device status to 'syncing'
      await devicePairing.setDeviceSyncing(finalDeviceId);
      console.log('🔄 Device status set to syncing');
    }

    if (!finalDeviceId) {
      console.error('❌ No device ID provided');
      return res.status(400).json({ error: 'Device ID or pairing code required' });
    }

    console.log('🔗 Attempting to pair device', finalDeviceId, 'to user', userId);
    const device = await devicePairing.pairDeviceToUser(finalDeviceId, userId, location);

    console.log('✅ Device paired successfully:', {
      serialNumber: device.serial_number,
      deviceName: device.device_name,
      userId: userId
    });

    res.json({
      success: true,
      device: {
        id: device.id,
        serialNumber: device.serial_number,
        deviceName: device.device_name,
        location: device.location,
        pairedAt: device.paired_at
      }
    });
  } catch (error) {
    console.error('❌ Device pairing failed:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: error.message || 'Pairing failed' });
  }
});

// Get user's devices
app.get('/api/devices', authenticateToken, async (req, res) => {
  try {
    const devices = await devicePairing.getUserDevices(req.user.userId);

    res.json({
      success: true,
      devices: devices.map(d => ({
        id: d.id,
        serialNumber: d.serial_number,
        deviceName: d.device_name,
        buildNumber: d.build_number,
        firmwareVersion: d.firmware_version,
        location: d.location,
        status: d.status,
        pairedAt: d.paired_at,
        lastSeen: d.last_seen
      }))
    });
  } catch (error) {
    console.error('Failed to get devices:', error);
    res.status(500).json({ error: 'Failed to retrieve devices' });
  }
});

// Update device info
app.put('/api/devices/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    console.log('═══════════════════════════════════════');
    console.log('🔄 DEVICE UPDATE REQUEST');
    console.log('═══════════════════════════════════════');
    console.log('   Device ID:', id);
    console.log('   Updates:', JSON.stringify(updates, null, 2));
    console.log('   User ID:', req.user.userId);

    // Check group membership BEFORE update
    const groupMembershipBefore = await pool.query(`
      SELECT dsgd.group_id, dsg.group_name
      FROM display_selection_group_devices dsgd
      INNER JOIN display_selection_groups dsg ON dsgd.group_id = dsg.id
      WHERE dsgd.device_id = $1
    `, [id]);
    console.log('   Group membership BEFORE update:', groupMembershipBefore.rows);

    // Check schedules count BEFORE update
    const schedulesBefore = await pool.query(`
      SELECT COUNT(*) as count FROM schedules WHERE device_id = $1
    `, [id]);
    console.log('   Schedules count BEFORE update:', schedulesBefore.rows[0].count);

    const device = await devicePairing.updateDevice(id, updates);

    if (!device) {
      console.log('❌ Device not found:', id);
      return res.status(404).json({ error: 'Device not found' });
    }

    console.log('✅ Device updated successfully:');
    console.log('   Serial:', device.serial_number);
    console.log('   New name:', device.device_name);
    console.log('   ID (should not change):', device.id);

    // Check group membership AFTER update
    const groupMembershipAfter = await pool.query(`
      SELECT dsgd.group_id, dsg.group_name
      FROM display_selection_group_devices dsgd
      INNER JOIN display_selection_groups dsg ON dsgd.group_id = dsg.id
      WHERE dsgd.device_id = $1
    `, [id]);
    console.log('   Group membership AFTER update:', groupMembershipAfter.rows);

    // Check schedules count AFTER update
    const schedulesAfter = await pool.query(`
      SELECT COUNT(*) as count FROM schedules WHERE device_id = $1
    `, [id]);
    console.log('   Schedules count AFTER update:', schedulesAfter.rows[0].count);

    // WARNING: Check if anything changed unexpectedly
    if (groupMembershipBefore.rows.length !== groupMembershipAfter.rows.length) {
      console.log('⚠️  WARNING: Group membership changed during update!');
      console.log('   BEFORE:', groupMembershipBefore.rows.length, 'groups');
      console.log('   AFTER:', groupMembershipAfter.rows.length, 'groups');
    }

    if (schedulesBefore.rows[0].count !== schedulesAfter.rows[0].count) {
      console.log('⚠️  WARNING: Schedules count changed during update!');
      console.log('   BEFORE:', schedulesBefore.rows[0].count, 'schedules');
      console.log('   AFTER:', schedulesAfter.rows[0].count, 'schedules');
    }

    console.log('═══════════════════════════════════════\n');

    // If device name was updated, broadcast to all connected displays
    if (updates.deviceName) {
      const connectedClients = io.engine.clientsCount;
      console.log('📡 Broadcasting device name update to', connectedClients, 'clients');
      console.log('📝 Serial:', device.serial_number, '| New Name:', updates.deviceName);

      io.emit('device-name-updated', {
        serialNumber: device.serial_number,
        deviceName: updates.deviceName
      });

      console.log('✅ Broadcast sent!');
    }

    res.json({ success: true, device });
  } catch (error) {
    console.error('❌ Device update failed:', error);
    res.status(500).json({ error: 'Failed to update device' });
  }
});

// Unpair device
app.post('/api/devices/:id/unpair', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const device = await devicePairing.unpairDevice(id, req.user.userId);

    console.log('📤 Device unpaired:', device.serial_number);

    res.json({
      success: true,
      message: 'Device unpaired successfully',
      newPairingCode: device.pairing_code
    });
  } catch (error) {
    console.error('Unpair failed:', error);
    res.status(500).json({ error: error.message || 'Failed to unpair device' });
  }
});

// ⚠️ TESTING ONLY: Reset all test displays
// This endpoint unpairs ALL devices in the database and generates fresh pairing codes
app.post('/api/testing/reset-all-displays', async (req, res) => {
  try {
    console.log('🧪 TESTING: Resetting all displays in database...');

    // Delete all existing displays and their pairing codes
    const deleteResult = await pool.query('DELETE FROM displays RETURNING serial_number');
    console.log(`🗑️ Deleted ${deleteResult.rows.length} displays from database`);

    res.json({
      success: true,
      message: `Reset complete. Deleted ${deleteResult.rows.length} displays. All display serials cleared.`,
      deletedCount: deleteResult.rows.length
    });
  } catch (error) {
    console.error('❌ Reset failed:', error);
    res.status(500).json({ error: 'Failed to reset displays' });
  }
});

// Unlink device with password verification (for user-initiated removal)
app.post('/api/devices/:id/unlink', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    const userId = req.user.userId;

    console.log('🔓 Unlink request received for device:', id, 'user:', userId);

    // Verify password
    const { verifyUserPassword } = require('./auth');
    const isValidPassword = await verifyUserPassword(userId, password);
    
    if (!isValidPassword) {
      console.warn('⚠️ Failed unlink attempt - invalid password for user:', userId);
      return res.status(401).json({ error: 'Incorrect password' });
    }

    // Get device info before unlinking (for logging)
    // Use devicePairing module to avoid direct pool queries
    const allDevices = await devicePairing.getUserDevices(userId);
    const deviceInfo = allDevices.find(d => d.id === parseInt(id));

    if (!deviceInfo) {
      console.warn('⚠️ Device not found or not owned by user:', id, userId);
      return res.status(404).json({ error: 'Device not found or not owned by you' });
    }

    const deviceData = {
      serial_number: deviceInfo.serial_number,
      device_name: deviceInfo.device_name
    };

    // Clear any pending schedules for this user before unlinking
    try {
      await pool.query('DELETE FROM schedules WHERE user_id = $1 AND status = \'pending\'', [userId]);
      console.log('✅ Cleared pending schedules for user:', userId);
    } catch (error) {
      console.error('⚠️  Failed to clear schedules:', error);
    }

    // Clear current display if it belongs to this user
    try {
      await currentDisplayDb.clear();
      currentContent = null;
      io.emit('clear-content');
      console.log('✅ Cleared current display content');
    } catch (error) {
      console.error('⚠️  Failed to clear current display:', error);
    }

    // Remove device from all device groups and selection groups
    try {
      await pool.query('DELETE FROM device_group_members WHERE device_id = $1', [id]);
      console.log('✅ Removed device from all device groups');

      await pool.query('DELETE FROM display_selection_group_devices WHERE device_id = $1', [id]);
      console.log('✅ Removed device from all selection groups');
    } catch (error) {
      console.error('⚠️  Failed to remove device from groups:', error);
    }

    // Unlink device (generates new pairing code)
    const device = await devicePairing.unpairDevice(id, userId);

    // Log detailed activity
    await devicePairing.logDeviceActivity(id, userId, 'unlinked_by_user', req.ip, {
      deviceName: deviceData.device_name,
      serialNumber: deviceData.serial_number,
      reason: 'User-initiated unlink with password verification',
      newPairingCode: device.pairing_code
    });

    console.log('🔓 Device unlinked:', deviceData.serial_number, 'from user:', userId);

    // Emit event to refresh groups for this user
    io.emit('groups-updated', { userId });
    console.log('📡 Emitted groups-updated event for user:', userId);

    res.json({
      success: true,
      message: 'Device unlinked successfully',
      device: {
        serialNumber: device.serial_number,
        newPairingCode: device.pairing_code,
        expiresAt: device.pairing_code_expires_at
      }
    });
  } catch (error) {
    console.error('Unlink device failed:', error);
    res.status(500).json({ error: error.message || 'Failed to unlink device' });
  }
});

// Revoke device
app.delete('/api/devices/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await devicePairing.revokeDevice(id, req.user.userId);

    console.log('🗑️ Device revoked:', id);

    res.json({ success: true, message: 'Device revoked successfully' });
  } catch (error) {
    console.error('Revoke failed:', error);
    res.status(500).json({ error: error.message || 'Failed to revoke device' });
  }
});

// ============================================
// DEVICE SETTINGS ROUTES (Phase 2.3)
// ============================================

const deviceSecurity = require('./deviceSecurity');

// Update device MAC address
app.put('/api/devices/:id/mac-address', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { macAddress } = req.body;
    const userId = req.user.userId;

    if (!macAddress) {
      return res.status(400).json({ error: 'MAC address is required' });
    }

    // Validate MAC address format
    if (!deviceSecurity.validateMACAddress(macAddress)) {
      return res.status(400).json({ error: 'Invalid MAC address format. Use XX:XX:XX:XX:XX:XX or XX-XX-XX-XX-XX-XX' });
    }

    // Normalize MAC address
    const normalizedMAC = deviceSecurity.normalizeMACAddress(macAddress);

    // Verify device ownership
    const devices = await devicePairing.getUserDevices(userId);
    const device = devices.find(d => d.id === parseInt(id));

    if (!device) {
      return res.status(404).json({ error: 'Device not found or not owned by you' });
    }

    // Update MAC address
    const query = `
      UPDATE displays 
      SET mac_address = $1
      WHERE id = $2 AND user_id = $3
      RETURNING *
    `;

    const result = await pool.query(query, [normalizedMAC, id, userId]);

    // Log activity
    await devicePairing.logDeviceActivity(id, userId, 'mac_address_updated', req.ip, {
      macAddress: normalizedMAC
    });

    console.log('✅ MAC address updated for device:', id, '→', normalizedMAC);

    res.json({
      success: true,
      device: result.rows[0]
    });
  } catch (error) {
    console.error('Failed to update MAC address:', error);
    if (error.code === '23505') { // Unique constraint violation
      return res.status(409).json({ error: 'This MAC address is already registered to another device' });
    }
    res.status(500).json({ error: 'Failed to update MAC address' });
  }
});

// Configure Wi-Fi for device
app.put('/api/devices/:id/wifi', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { ssid, password } = req.body;
    const userId = req.user.userId;

    if (!ssid || !password) {
      return res.status(400).json({ error: 'SSID and password are required' });
    }

    // Verify device ownership
    const devices = await devicePairing.getUserDevices(userId);
    const device = devices.find(d => d.id === parseInt(id));

    if (!device) {
      return res.status(404).json({ error: 'Device not found or not owned by you' });
    }

    // Encrypt password
    const encryptedPassword = deviceSecurity.encryptWiFiPassword(password);

    // Update Wi-Fi configuration
    const query = `
      UPDATE displays 
      SET wifi_ssid = $1,
          wifi_password_encrypted = $2,
          wifi_configured = TRUE,
          wifi_last_updated = NOW()
      WHERE id = $3 AND user_id = $4
      RETURNING id, serial_number, device_name, wifi_ssid, wifi_configured, wifi_last_updated
    `;

    const result = await pool.query(query, [ssid, encryptedPassword, id, userId]);

    // Log activity
    await devicePairing.logDeviceActivity(id, userId, 'wifi_configured', req.ip, {
      ssid: ssid
    });

    console.log('✅ Wi-Fi configured for device:', id, '| SSID:', ssid);

    // Notify the display device about Wi-Fi update (if connected)
    const displayConnection = Array.from(connectedDisplays.entries())
      .find(([serial, info]) => info.userId === userId && result.rows[0].serial_number === serial);
    
    if (displayConnection) {
      io.to(displayConnection[1].socketId).emit('wifi-config-updated', {
        ssid,
        password, // Send plain password to display for connection
        configured: true
      });
      console.log('📡 Sent Wi-Fi config to display');
    }

    res.json({
      success: true,
      device: result.rows[0]
    });
  } catch (error) {
    console.error('Failed to configure Wi-Fi:', error);
    res.status(500).json({ error: 'Failed to configure Wi-Fi' });
  }
});

// Get Wi-Fi configuration (SSID only, not password)
app.get('/api/devices/:id/wifi', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const query = `
      SELECT wifi_ssid, wifi_configured, wifi_last_updated
      FROM displays 
      WHERE id = $1 AND user_id = $2
    `;

    const result = await pool.query(query, [id, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found or not owned by you' });
    }

    res.json({
      success: true,
      wifi: result.rows[0]
    });
  } catch (error) {
    console.error('Failed to get Wi-Fi config:', error);
    res.status(500).json({ error: 'Failed to get Wi-Fi configuration' });
  }
});

// Get device activity log
app.get('/api/devices/:id/activity', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50 } = req.query;
    const userId = req.user.userId;

    // Verify device ownership
    const devices = await devicePairing.getUserDevices(userId);
    const device = devices.find(d => d.id === parseInt(id));

    if (!device) {
      return res.status(404).json({ error: 'Device not found or not owned by you' });
    }

    // Get activity logs
    const query = `
      SELECT 
        id,
        activity_type,
        ip_address,
        details,
        created_at
      FROM device_activity
      WHERE device_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;

    const result = await pool.query(query, [id, parseInt(limit)]);

    res.json({
      success: true,
      activities: result.rows.map(row => ({
        id: row.id,
        type: row.activity_type,
        ipAddress: row.ip_address,
        details: row.details,
        timestamp: row.created_at
      }))
    });
  } catch (error) {
    console.error('Failed to get device activity:', error);
    res.status(500).json({ error: 'Failed to get device activity' });
  }
});

// Get display history for device
app.get('/api/devices/:id/display-history', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50 } = req.query;
    const userId = req.user.userId;

    // Verify device ownership
    const devices = await devicePairing.getUserDevices(userId);
    const device = devices.find(d => d.id === parseInt(id));

    if (!device) {
      return res.status(404).json({ error: 'Device not found or not owned by you' });
    }

    // Get display history
    const query = `
      SELECT 
        id,
        image_url,
        displayed_at,
        duration,
        rotation,
        mirror,
        schedule_id
      FROM display_history
      ORDER BY displayed_at DESC
      LIMIT $1
    `;

    const result = await pool.query(query, [parseInt(limit)]);

    res.json({
      success: true,
      history: result.rows.map(row => ({
        id: row.id,
        imageUrl: row.image_url,
        displayedAt: row.displayed_at,
        duration: row.duration,
        rotation: row.rotation,
        mirror: row.mirror,
        scheduleId: row.schedule_id
      }))
    });
  } catch (error) {
    console.error('Failed to get display history:', error);
    res.status(500).json({ error: 'Failed to get display history' });
  }
});

// Get device statistics
app.get('/api/devices/:id/stats', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Verify device ownership
    const devices = await devicePairing.getUserDevices(userId);
    const device = devices.find(d => d.id === parseInt(id));

    if (!device) {
      return res.status(404).json({ error: 'Device not found or not owned by you' });
    }

    // Get various statistics
    const stats = {};

    // Total displays count
    const displayCountQuery = 'SELECT COUNT(*) as count FROM display_history';
    const displayCount = await pool.query(displayCountQuery);
    stats.totalDisplays = parseInt(displayCount.rows[0].count);

    // Total activity count
    const activityCountQuery = 'SELECT COUNT(*) as count FROM device_activity WHERE device_id = $1';
    const activityCount = await pool.query(activityCountQuery, [id]);
    stats.totalActivities = parseInt(activityCount.rows[0].count);

    // Uptime calculation (time since pairing)
    if (device.paired_at) {
      const now = new Date();
      const paired = new Date(device.paired_at);
      const uptimeMs = now - paired;
      const uptimeDays = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
      stats.uptimeDays = uptimeDays;
    } else {
      stats.uptimeDays = 0;
    }

    // Last activity
    const lastActivityQuery = `
      SELECT activity_type, created_at 
      FROM device_activity 
      WHERE device_id = $1 
      ORDER BY created_at DESC 
      LIMIT 1
    `;
    const lastActivity = await pool.query(lastActivityQuery, [id]);
    if (lastActivity.rows.length > 0) {
      stats.lastActivity = {
        type: lastActivity.rows[0].activity_type,
        timestamp: lastActivity.rows[0].created_at
      };
    }

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Failed to get device stats:', error);
    res.status(500).json({ error: 'Failed to get device statistics' });
  }
});

// ============================================
// TWO-FACTOR AUTHENTICATION ROUTES
// ============================================

// Setup 2FA (generate QR code and secret)
app.post('/api/auth/2fa/setup', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const user = await getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate 2FA secret
    const result = await twoFactorAuth.generate2FASecret(user.email);

    console.log('✅ 2FA setup initiated for user:', userId);

    res.json({
      success: true,
      secret: result.secret,
      qrCode: result.qrCode
    });
  } catch (error) {
    console.error('2FA setup failed:', error);
    res.status(500).json({ error: 'Failed to setup 2FA' });
  }
});

// Enable 2FA
app.post('/api/auth/2fa/enable', authenticateToken, async (req, res) => {
  try {
    const { method, phoneNumber } = req.body;
    const userId = req.user.userId;

    const result = await twoFactorAuth.enable2FA(userId, method, phoneNumber);

    console.log('✅ 2FA enabled for user:', userId);

    res.json({
      success: true,
      secret: result.secret,
      qrCodeData: result.qrCodeData,
      backupCodes: result.backupCodes,
      message: 'Save your backup codes in a safe place'
    });
  } catch (error) {
    console.error('2FA enable failed:', error);
    res.status(500).json({ error: 'Failed to enable 2FA' });
  }
});

// Disable 2FA
app.post('/api/auth/2fa/disable', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    await twoFactorAuth.disable2FA(userId);

    console.log('❌ 2FA disabled for user:', userId);

    res.json({ success: true, message: '2FA disabled successfully' });
  } catch (error) {
    console.error('2FA disable failed:', error);
    res.status(500).json({ error: 'Failed to disable 2FA' });
  }
});

// Verify 2FA token (during setup - this enables 2FA)
app.post('/api/auth/2fa/verify', authenticateToken, async (req, res) => {
  try {
    const { token, secret } = req.body;
    const userId = req.user.userId;

    if (!token) {
      return res.status(400).json({ error: '2FA token required' });
    }

    // If secret is provided, this is the initial setup verification
    if (secret) {
      // Verify the code matches the secret
      const isValid = twoFactorAuth.verifyTOTP(secret, token);
      
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid verification code' });
      }

      // Code is valid - enable 2FA with this secret
      const result = await twoFactorAuth.enableWithSecret(userId, secret);
      
      console.log('✅ 2FA enabled for user:', userId);
      
      return res.json({ 
        success: true, 
        message: '2FA enabled successfully',
        backupCodes: result.backupCodes 
      });
    }

    // Otherwise, verify against already-enabled 2FA
    const result = await twoFactorAuth.verify2FAToken(userId, token);

    if (!result.valid) {
      return res.status(401).json({ error: result.reason || 'Invalid 2FA token' });
    }

    res.json({ success: true, method: result.method });
  } catch (error) {
    console.error('2FA verification failed:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Get 2FA status
app.get('/api/auth/2fa/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const isEnabled = await twoFactorAuth.is2FAEnabled(userId);

    res.json({ enabled: isEnabled });
  } catch (error) {
    console.error('Failed to get 2FA status:', error);
    res.status(500).json({ error: 'Failed to get 2FA status' });
  }
});

// ============================================
// EMAIL VERIFICATION ROUTES
// ============================================

// Verify email with token
app.get('/api/auth/verify-email', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: 'Verification token required' });
    }

    const result = await emailVerification.verifyToken(token);

    if (!result.valid) {
      return res.status(400).json({ error: result.reason });
    }

    console.log('✅ Email verified for user:', result.userId);

    res.json({ success: true, message: 'Email verified successfully' });
  } catch (error) {
    console.error('Email verification failed:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Resend verification email
app.post('/api/auth/resend-verification', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await emailVerification.resendVerificationEmail(userId);

    if (!result.success) {
      return res.status(400).json({ error: result.reason });
    }

    res.json({ success: true, message: 'Verification email sent' });
  } catch (error) {
    console.error('Failed to resend verification:', error);
    res.status(500).json({ error: 'Failed to send verification email' });
  }
});

// ============================================
// EXISTING ROUTES
// ============================================

io.on('connection', (socket) => {
  console.log('✅ Client connected:', socket.id);
  console.log('📈 Total connected clients:', io.engine.clientsCount);
  
  socket.on('register-display', async (data) => {
    const { serialNumber, name, timezone } = data;
    console.log('📺 Display registration request:', { serialNumber, name, timezone, socketId: socket.id });

    if (!serialNumber) {
      console.warn('⚠️  Display registered without serial number');
      return;
    }

    try {
      // Get device info and user association from database
      const device = await devicePairing.getDeviceBySerial(serialNumber);

      if (!device) {
        console.warn('⚠️  Unknown device serial:', serialNumber);
        return;
      }

      if (!device.is_paired || !device.user_id) {
        console.log('ℹ️  Device not paired yet:', serialNumber);
        return;
      }

      // Update device timezone in database if provided
      if (timezone) {
        await devicePairing.updateDeviceTimezone(device.id, timezone);
        console.log(`🌍 Updated device timezone to ${timezone}`);
      }

      // Store display connection with user association
      connectedDisplays.set(serialNumber, {
        socketId: socket.id,
        userId: device.user_id,
        deviceId: device.id,
        displayName: device.device_name || name || 'Display',
        timezone: timezone || device.device_timezone || 'UTC',
        connectedAt: new Date()
      });
      
      console.log('✅ Display registered:', serialNumber, '| User:', device.user_id, '| Device ID:', device.id, '| Socket:', socket.id);
      console.log('📊 Total registered displays:', connectedDisplays.size);

      // Check for active layout for this device
      const layoutQuery = `
        SELECT * FROM layouts
        WHERE device_id = $1 AND user_id = $2 AND is_active = TRUE
        LIMIT 1
      `;
      const layoutResult = await pool.query(layoutQuery, [device.id, device.user_id]);

      if (layoutResult.rows.length > 0) {
        const activeLayout = layoutResult.rows[0];
        console.log(`📐 Found active layout for device: ${activeLayout.name}`);

        // Fetch media URLs for all zones
        const zones = activeLayout.layout_data?.zones || [];
        const zonesWithMedia = await Promise.all(zones.map(async (zone) => {
          if (zone.contentId) {
            const mediaQuery = `
              SELECT image_url, media_type, thumbnail_url FROM upload_history
              WHERE id = $1 AND user_id = $2
            `;
            const mediaResult = await pool.query(mediaQuery, [zone.contentId, device.user_id]);
            if (mediaResult.rows.length > 0) {
              const media = mediaResult.rows[0];
              return {
                ...zone,
                mediaUrl: media.image_url,
                mediaType: media.media_type,
                thumbnailUrl: media.thumbnail_url
              };
            }
          }
          return zone;
        }));

        const layoutPayload = {
          type: 'layout',
          layoutId: activeLayout.id,
          layoutName: activeLayout.name,
          templateId: activeLayout.template_id,
          zones: zonesWithMedia
        };

        socket.emit('display-content', layoutPayload);
        console.log(`✅ Sent active layout to newly connected display (Device ID: ${device.id})`);
      } else {
        // No active layout - check for scheduled content
        const deviceSchedules = await scheduleDb.getPending(device.user_id, device.id);
        if (deviceSchedules.length > 0) {
          const schedule = deviceSchedules[0];
          const now = new Date();
          const content = {
            type: schedule.content_type || 'image',
            url: schedule.image_url,
            rotation: schedule.rotation || 0,
            mirror: schedule.mirror || false,
            duration: schedule.duration,
            displayedAt: now,
            clearAt: new Date(now.getTime() + schedule.duration),
            thumbnailUrl: schedule.thumbnail_url || null
          };
          socket.emit('display-content', content);
          console.log(`📤 Sent pending ${content.type} to newly connected display (Device ID: ${device.id})`);
        }
      }
    } catch (error) {
      console.error('❌ Error registering display:', error);
    }
  });
  
  socket.on('disconnect', () => {
    // Find and remove this socket from connected displays
    for (const [serialNumber, displayInfo] of connectedDisplays.entries()) {
      if (displayInfo.socketId === socket.id) {
        connectedDisplays.delete(serialNumber);
        console.log('❌ Display disconnected:', serialNumber);
        console.log('📊 Total registered displays:', connectedDisplays.size);
        break;
      }
    }
    console.log('📉 Total connected clients:', io.engine.clientsCount);
  });
});

app.post('/api/upload', uploadLimiter, hourlyUploadLimiter, optionalAuth, upload.single('image'), async (req, res) => {
  try {
    // Check for authentication - EITHER admin password OR user token
    const authPassword = req.headers['x-admin-password'];
    const hasAdminPassword = authPassword === process.env.ADMIN_PASSWORD;
    const hasUserToken = req.user && req.user.userId; // Set by optionalAuth middleware
    
    const isAuthenticated = hasAdminPassword || hasUserToken;
    
    // Log authentication status
    console.log('Upload attempt - Admin:', hasAdminPassword, '| User:', hasUserToken, '| Authenticated:', isAuthenticated);
    
    // ENFORCE: Block unauthenticated requests
    if (!isAuthenticated) {
      console.warn('⚠️  BLOCKED: Unauthenticated upload attempt');
      return res.status(401).json({ error: 'Unauthorized - Authentication required' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Log upload details
    const isGif = req.file.mimetype === 'image/gif';
    console.log(`📤 Uploading ${isGif ? 'GIF' : 'image'}:`, req.file.originalname, `(${(req.file.size / 1024).toFixed(2)} KB)`);
    if (isGif) {
      console.log('🎨 GIF detected - preserving animation with "animated" flag');
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'digital-signage',
        resource_type: 'image', // Changed from 'auto' to 'image' for better GIF handling
        format: isGif ? 'gif' : undefined, // Force GIF format for GIFs
        flags: isGif ? 'animated' : undefined, // Preserve GIF animation
        quality: isGif ? undefined : 'auto:good',  // Auto quality for non-GIF images
        fetch_format: isGif ? undefined : 'auto',  // Auto format selection for non-GIFs
        transformation: isGif ? undefined : [
          {
            quality: 'auto:good',
            fetch_format: 'auto',
            flags: 'progressive'  // Progressive loading for better UX
          }
        ],
        invalidate: true, // Clear CDN cache to ensure latest version
        access_control: [{ access_type: 'anonymous' }] // Allow CORS for audio analysis
      },
      async (error, result) => {
        if (error) {
          console.error('Cloudinary error:', error);
          return res.status(500).json({ error: 'Upload failed' });
        }

        // Log success with format info
        console.log(`✅ Upload successful - Format: ${result.format}, URL: ${result.secure_url}`);

        // For GIFs, ensure the URL explicitly requests GIF format with animation
        let finalUrl = result.secure_url;
        if (result.format === 'gif') {
          // Modify Cloudinary URL to explicitly request animated GIF
          // Change /upload/ to /upload/fl_animated/
          finalUrl = result.secure_url.replace('/upload/', '/upload/fl_animated/');
          console.log('🎨 GIF uploaded successfully with animation preserved');
          console.log('🔗 Modified URL for animation:', finalUrl);
        }

        // Save upload history to database
        try {
          await uploadDb.create({
            imageUrl: finalUrl,
            imageId: result.public_id,
            fileSize: req.file.size,
            ipAddress: req.ip,
            userId: hasUserToken ? req.user.userId : null,
            mediaType: 'image',
            title: req.body.title || req.file.originalname,
            publicId: result.public_id
          });
          console.log('✅ Upload logged to database');
        } catch (dbError) {
          console.error('⚠️  Failed to log upload to database:', dbError);
          // Don't fail the request if logging fails
        }

        res.json({
          success: true,
          image: {
            id: result.public_id,
            url: finalUrl
          }
        });
      }
    );

    streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/api/upload/video', uploadLimiter, hourlyUploadLimiter, optionalAuth, uploadVideo.single('video'), async (req, res) => {
  try {
    // Check for authentication - EITHER admin password OR user token
    const authPassword = req.headers['x-admin-password'];
    const hasAdminPassword = authPassword === process.env.ADMIN_PASSWORD;
    const hasUserToken = req.user && req.user.userId; // Set by optionalAuth middleware

    const isAuthenticated = hasAdminPassword || hasUserToken;

    // Log authentication status
    console.log('Video upload attempt - Admin:', hasAdminPassword, '| User:', hasUserToken, '| Authenticated:', isAuthenticated);

    // ENFORCE: Block unauthenticated requests
    if (!isAuthenticated) {
      console.warn('⚠️  BLOCKED: Unauthenticated video upload attempt');
      return res.status(401).json({ error: 'Unauthorized - Authentication required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    console.log('📹 Video upload started - Size:', req.file.size, 'bytes');

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'video',
        folder: 'digital-signage/videos',
        quality: 'auto:good',  // Auto-detect best quality/size ratio
        fetch_format: 'auto',   // Auto-select best format (WebP, MP4, etc.)
        transformation: [
          {
            quality: 'auto:good',
            fetch_format: 'auto',
            flags: 'progressive'  // Progressive loading
          }
        ],
        eager: [
          // High-quality thumbnail from video frame at 1 second (avoid black frames)
          {
            format: 'jpg',
            transformation: [
              {
                width: 400,
                height: 300,
                crop: 'fill',
                gravity: 'auto',       // Auto-detect best frame
                quality: 'auto:good',
                start_offset: '1.0'    // 1 second into video
              }
            ]
          },
          // Animated GIF preview (first 3 seconds)
          {
            format: 'gif',
            transformation: [
              {
                width: 400,
                crop: 'scale',
                duration: '3',         // 3 seconds
                fps: 10,               // 10 frames per second
                effect: 'loop'
              }
            ]
          },
          // HLS adaptive streaming (multiple quality levels)
          {
            streaming_profile: 'hd',
            format: 'm3u8'
          }
        ],
        eager_async: true,  // Process transformations in background to avoid timeout
        access_control: [{ access_type: 'anonymous' }] // Allow CORS for audio analysis
      },
      async (error, result) => {
        if (error) {
          console.error('Cloudinary video upload error:', error);
          return res.status(500).json({ error: 'Video upload failed' });
        }

        // Extract video metadata from Cloudinary response
        const videoMetadata = {
          url: result.secure_url,
          publicId: result.public_id,
          format: result.format,
          duration: result.duration, // Duration in seconds
          width: result.width,
          height: result.height,
          resolution: `${result.width}x${result.height}`,
          sizeBytes: result.bytes,
          thumbnailUrl: result.eager && result.eager.length > 0 ? result.eager[0].secure_url : null,
          gifPreviewUrl: result.eager && result.eager.length > 1 ? result.eager[1].secure_url : null,
          streamingUrl: result.eager && result.eager.length > 2 ? result.eager[2].secure_url : null
        };

        console.log('✅ Video uploaded successfully:', videoMetadata.publicId);
        console.log('📊 Video metadata:', {
          format: videoMetadata.format,
          duration: videoMetadata.duration,
          resolution: videoMetadata.resolution,
          size: videoMetadata.sizeBytes,
          hasGifPreview: !!videoMetadata.gifPreviewUrl,
          hasStreamingUrl: !!videoMetadata.streamingUrl
        });

        // Save upload history to database
        try {
          await uploadDb.create({
            imageUrl: result.secure_url,
            imageId: result.public_id,
            fileSize: result.bytes,
            ipAddress: req.ip,
            userId: hasUserToken ? req.user.userId : null,
            mediaType: 'video',
            title: req.body.title || req.file.originalname,
            duration: result.duration,
            thumbnailUrl: videoMetadata.thumbnailUrl,
            publicId: result.public_id
          });
          console.log('✅ Video upload logged to database');
        } catch (dbError) {
          console.error('⚠️  Failed to log video upload to database:', dbError);
          // Don't fail the request if logging fails
        }

        res.json({
          success: true,
          video: {
            id: videoMetadata.publicId,
            url: videoMetadata.url,
            format: videoMetadata.format,
            duration: videoMetadata.duration,
            resolution: videoMetadata.resolution,
            sizeBytes: videoMetadata.sizeBytes,
            thumbnailUrl: videoMetadata.thumbnailUrl,
            gifPreviewUrl: videoMetadata.gifPreviewUrl,  // Animated preview
            streamingUrl: videoMetadata.streamingUrl      // HLS adaptive streaming
          }
        });
      }
    );

    streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
  } catch (error) {
    console.error('Video upload error:', error);
    res.status(500).json({ error: 'Video upload failed' });
  }
});

// Get user's media library (images and videos)
app.get('/api/media', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const userId = req.user.userId;
    const mediaType = req.query.type; // Optional filter: 'image' or 'video'
    const limit = parseInt(req.query.limit) || 100;

    console.log(`📚 Fetching media library for user ${userId}`, mediaType ? `(type: ${mediaType})` : '');

    let query = `
      SELECT
        id,
        image_url as url,
        public_id as publicId,
        media_type as type,
        title,
        file_size as fileSize,
        duration,
        thumbnail_url as thumbnailUrl,
        uploaded_at as uploadedAt
      FROM upload_history
      WHERE user_id = $1
    `;

    const values = [userId];

    // Add optional media type filter
    if (mediaType && (mediaType === 'image' || mediaType === 'video')) {
      query += ` AND media_type = $2`;
      values.push(mediaType);
      query += ` ORDER BY uploaded_at DESC LIMIT $3`;
      values.push(limit);
    } else {
      query += ` ORDER BY uploaded_at DESC LIMIT $2`;
      values.push(limit);
    }

    const result = await pool.query(query, values);

    console.log(`✅ Found ${result.rows.length} media items`);

    res.json({
      success: true,
      media: result.rows,
      total: result.rows.length
    });

  } catch (error) {
    console.error('Error fetching media library:', error);
    res.status(500).json({ error: 'Failed to fetch media library' });
  }
});

// ============================================
// LAYOUT ENDPOINTS
// ============================================

// Create a new layout
app.post('/api/layouts', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const { name, templateId, deviceId, layoutData, isActive } = req.body;
    const userId = req.user.userId;

    if (!name || !templateId || !layoutData) {
      return res.status(400).json({ error: 'Missing required fields: name, templateId, layoutData' });
    }

    console.log(`📐 Creating layout "${name}" for user ${userId}`);

    const query = `
      INSERT INTO layouts (user_id, device_id, name, template_id, layout_data, is_active)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    const values = [
      userId,
      deviceId || null,
      name,
      templateId,
      JSON.stringify(layoutData),
      isActive || false
    ];

    const result = await pool.query(query, values);

    console.log(`✅ Layout created with ID: ${result.rows[0].id}`);

    res.json({
      success: true,
      layout: result.rows[0]
    });

  } catch (error) {
    console.error('Error creating layout:', error);
    res.status(500).json({ error: 'Failed to create layout' });
  }
});

// Get all layouts for the authenticated user
app.get('/api/layouts', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const userId = req.user.userId;
    const deviceId = req.query.deviceId; // Optional filter

    console.log(`📐 Fetching layouts for user ${userId}`, deviceId ? `(device: ${deviceId})` : '');

    let query = `
      SELECT * FROM layouts
      WHERE user_id = $1
    `;

    const values = [userId];

    if (deviceId) {
      query += ` AND device_id = $2`;
      values.push(deviceId);
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, values);

    console.log(`✅ Found ${result.rows.length} layouts`);

    res.json({
      success: true,
      layouts: result.rows
    });

  } catch (error) {
    console.error('Error fetching layouts:', error);
    res.status(500).json({ error: 'Failed to fetch layouts' });
  }
});

// Get a specific layout by ID
app.get('/api/layouts/:id', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const layoutId = req.params.id;
    const userId = req.user.userId;

    console.log(`📐 Fetching layout ${layoutId} for user ${userId}`);

    const query = `
      SELECT * FROM layouts
      WHERE id = $1 AND user_id = $2
    `;

    const result = await pool.query(query, [layoutId, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Layout not found' });
    }

    console.log(`✅ Layout found: ${result.rows[0].name}`);

    res.json({
      success: true,
      layout: result.rows[0]
    });

  } catch (error) {
    console.error('Error fetching layout:', error);
    res.status(500).json({ error: 'Failed to fetch layout' });
  }
});

// Update a layout
app.put('/api/layouts/:id', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const layoutId = req.params.id;
    const userId = req.user.userId;
    const { name, templateId, deviceId, layoutData, isActive } = req.body;

    console.log(`📐 Updating layout ${layoutId} for user ${userId}`);

    // Verify ownership
    const checkQuery = `
      SELECT * FROM layouts WHERE id = $1 AND user_id = $2
    `;
    const checkResult = await pool.query(checkQuery, [layoutId, userId]);

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Layout not found' });
    }

    // Build update query dynamically based on provided fields
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (templateId !== undefined) {
      updates.push(`template_id = $${paramIndex++}`);
      values.push(templateId);
    }
    if (deviceId !== undefined) {
      updates.push(`device_id = $${paramIndex++}`);
      values.push(deviceId);
    }
    if (layoutData !== undefined) {
      updates.push(`layout_data = $${paramIndex++}`);
      values.push(JSON.stringify(layoutData));
    }
    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(isActive);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(layoutId, userId);

    const updateQuery = `
      UPDATE layouts
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex++} AND user_id = $${paramIndex++}
      RETURNING *
    `;

    const result = await pool.query(updateQuery, values);

    console.log(`✅ Layout updated: ${result.rows[0].name}`);

    res.json({
      success: true,
      layout: result.rows[0]
    });

  } catch (error) {
    console.error('Error updating layout:', error);
    res.status(500).json({ error: 'Failed to update layout' });
  }
});

// Delete a layout
app.delete('/api/layouts/:id', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const layoutId = req.params.id;
    const userId = req.user.userId;

    console.log(`📐 Deleting layout ${layoutId} for user ${userId}`);

    const query = `
      DELETE FROM layouts
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `;

    const result = await pool.query(query, [layoutId, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Layout not found' });
    }

    console.log(`✅ Layout deleted: ${result.rows[0].name}`);

    res.json({
      success: true,
      message: 'Layout deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting layout:', error);
    res.status(500).json({ error: 'Failed to delete layout' });
  }
});

// Activate a layout (set is_active to true, deactivate others for the same device)
app.put('/api/layouts/:id/activate', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const layoutId = req.params.id;
    const userId = req.user.userId;
    const { deviceId } = req.body; // Accept deviceId from request body

    console.log(`📐 Activating layout ${layoutId} for user ${userId} on device ${deviceId}`);

    // Get the layout
    const layoutQuery = `
      SELECT * FROM layouts WHERE id = $1 AND user_id = $2
    `;
    const layoutResult = await pool.query(layoutQuery, [layoutId, userId]);

    if (layoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Layout not found' });
    }

    // If deviceId provided, verify user owns the device
    if (deviceId) {
      const deviceQuery = `
        SELECT * FROM displays WHERE id = $1 AND user_id = $2
      `;
      const deviceResult = await pool.query(deviceQuery, [deviceId, userId]);

      if (deviceResult.rows.length === 0) {
        return res.status(404).json({ error: 'Device not found or not authorized' });
      }

      // Deactivate all other layouts for this device
      await pool.query(
        `UPDATE layouts SET is_active = FALSE WHERE device_id = $1 AND user_id = $2 AND id != $3`,
        [deviceId, userId, layoutId]
      );
    }

    // Activate this layout and assign device
    const activateQuery = `
      UPDATE layouts
      SET is_active = TRUE, device_id = $1
      WHERE id = $2 AND user_id = $3
      RETURNING *
    `;

    const result = await pool.query(activateQuery, [deviceId, layoutId, userId]);
    const activatedLayout = result.rows[0];

    console.log(`✅ Layout activated: ${activatedLayout.name} on device ${deviceId}`);

    // Send layout to device via Socket.IO
    try {
      // Find the connected display by device ID
      let targetDisplay = null;
      for (const [serialNumber, displayInfo] of connectedDisplays.entries()) {
        if (displayInfo.deviceId === parseInt(deviceId)) {
          targetDisplay = { serialNumber, ...displayInfo };
          break;
        }
      }

      if (targetDisplay) {
        console.log(`📡 Found connected display for device ${deviceId}, sending layout...`);

        // Fetch media URLs for all zones
        const zones = activatedLayout.layout_data?.zones || [];
        const zonesWithMedia = await Promise.all(zones.map(async (zone) => {
          if (zone.contentId) {
            // Get media info from upload_history
            const mediaQuery = `
              SELECT image_url, media_type, thumbnail_url FROM upload_history
              WHERE id = $1 AND user_id = $2
            `;
            const mediaResult = await pool.query(mediaQuery, [zone.contentId, userId]);
            if (mediaResult.rows.length > 0) {
              const media = mediaResult.rows[0];
              return {
                ...zone,
                mediaUrl: media.image_url,
                mediaType: media.media_type,
                thumbnailUrl: media.thumbnail_url
              };
            }
          }
          return zone;
        }));

        // Send layout to display
        const layoutPayload = {
          type: 'layout',
          layoutId: activatedLayout.id,
          layoutName: activatedLayout.name,
          templateId: activatedLayout.template_id,
          zones: zonesWithMedia
        };

        io.to(targetDisplay.socketId).emit('display-content', layoutPayload);
        console.log(`✅ Layout sent to display ${targetDisplay.serialNumber} via Socket.IO`);
      } else {
        console.log(`⚠️ Device ${deviceId} not currently connected - layout will be sent when device connects`);
      }
    } catch (socketError) {
      console.error('❌ Error sending layout via Socket.IO:', socketError);
      // Don't fail the request if Socket.IO push fails
    }

    res.json({
      success: true,
      layout: activatedLayout,
      message: 'Layout activated successfully'
    });

  } catch (error) {
    console.error('Error activating layout:', error);
    res.status(500).json({ error: 'Failed to activate layout' });
  }
});

// Deactivate a layout (set is_active to false, clear from display)
app.put('/api/layouts/:id/deactivate', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const layoutId = req.params.id;
    const userId = req.user.userId;

    console.log(`📐 Deactivating layout ${layoutId} for user ${userId}`);

    // Get the layout to find its device_id
    const layoutQuery = `
      SELECT * FROM layouts WHERE id = $1 AND user_id = $2
    `;
    const layoutResult = await pool.query(layoutQuery, [layoutId, userId]);

    if (layoutResult.rows.length === 0) {
      return res.status(404).json({ error: 'Layout not found' });
    }

    const layout = layoutResult.rows[0];
    const deviceId = layout.device_id;

    // Deactivate the layout
    const deactivateQuery = `
      UPDATE layouts
      SET is_active = FALSE
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `;

    const result = await pool.query(deactivateQuery, [layoutId, userId]);

    console.log(`✅ Layout deactivated: ${result.rows[0].name}`);

    // Clear content from display via Socket.IO
    if (deviceId) {
      try {
        // Find the connected display by device ID
        let targetDisplay = null;
        for (const [serialNumber, displayInfo] of connectedDisplays.entries()) {
          if (displayInfo.deviceId === parseInt(deviceId)) {
            targetDisplay = { serialNumber, ...displayInfo };
            break;
          }
        }

        if (targetDisplay) {
          console.log(`📡 Found connected display for device ${deviceId}, clearing content...`);
          io.to(targetDisplay.socketId).emit('clear-content');
          console.log(`✅ Clear signal sent to display ${targetDisplay.serialNumber}`);
        } else {
          console.log(`⚠️ Device ${deviceId} not currently connected`);
        }
      } catch (socketError) {
        console.error('❌ Error clearing display via Socket.IO:', socketError);
        // Don't fail the request if Socket.IO fails
      }
    }

    res.json({
      success: true,
      layout: result.rows[0],
      message: 'Layout deactivated successfully'
    });

  } catch (error) {
    console.error('Error deactivating layout:', error);
    res.status(500).json({ error: 'Failed to deactivate layout' });
  }
});

app.post('/api/display-now', authenticateToken, apiLimiter, async (req, res) => {
  const {
    imageUrl,
    imageTitle,
    rotation,
    mirror,
    duration,
    contentType,
    videoFormat,
    videoResolution,
    videoSizeBytes,
    videoDurationAuto,
    thumbnailUrl,
    muted,
    clientTimestamp,
    deviceId,
    groupId,
    uploadedFromGroup
  } = req.body;
  const userId = req.user.userId;

  console.log('Display Now request received from user:', userId, {
    imageUrl,
    rotation,
    mirror,
    duration,
    contentType,
    muted: contentType === 'video' ? muted : undefined,
    clientTimestamp,
    deviceId,
    groupId,
    uploadedFromGroup
  });

  if (!imageUrl) {
    return res.status(400).json({ error: 'Content URL required' });
  }

  // Use client timestamp (should be UTC ISO string) or server time
  const now = clientTimestamp ? new Date(clientTimestamp) : new Date();
  const scheduledTimeForDb = clientTimestamp || new Date().toISOString();
  const displayDuration = duration || 60000; // Default 1 minute if not specified
  const userTz = req.body.userTimezone || 'UTC';

  console.log('🕐 Display Now:', {
    clientTimestamp,
    userTimezone: userTz,
    scheduledTimeForDb,
    displayTime: now.toLocaleString()
  });

  const content = {
    type: contentType || 'image',
    url: imageUrl,
    rotation: rotation || 0,
    mirror: mirror || false,
    duration: displayDuration,
    displayedAt: now,
    clearAt: new Date(now.getTime() + displayDuration),
    thumbnailUrl: thumbnailUrl || null,
    muted: muted || false
  };

  // If group upload, send to all devices in group
  let displaysSent = 0;
  let targetDevices = [];

  if (groupId && uploadedFromGroup) {
    // Get devices from selection group (not device group)
    const groupData = await displaySelectionGroups.getSelectionGroupWithDevices(groupId, userId);
    const groupDevices = groupData.devices;
    targetDevices = groupDevices;

    console.log('🔍 DEBUG - Group Devices:', groupDevices.map(d => ({ id: d.id, name: d.device_name })));
    console.log('🔍 DEBUG - Connected Displays:', Array.from(connectedDisplays.entries()).map(([serial, info]) => ({
      serial,
      userId: info.userId,
      deviceId: info.deviceId
    })));

    for (const device of groupDevices) {
      // Find connected display by device ID
      console.log(`🔍 Looking for device ID ${device.id} (${device.device_name})...`);
      for (const [serialNumber, displayInfo] of connectedDisplays.entries()) {
        console.log(`  - Checking ${serialNumber}: userId=${displayInfo.userId} (need ${userId}), deviceId=${displayInfo.deviceId} (need ${device.id})`);
        if (displayInfo.userId === userId && displayInfo.deviceId === device.id) {
          io.to(displayInfo.socketId).emit('display-content', content);
          console.log(`📤 Sent ${contentType || 'image'} to display ${serialNumber} (Device: ${device.device_name})`);
          displaysSent++;
        }
      }
    }
  } else if (deviceId) {
    // Send to specific device only
    for (const [serialNumber, displayInfo] of connectedDisplays.entries()) {
      if (displayInfo.userId === userId && displayInfo.deviceId === deviceId) {
        io.to(displayInfo.socketId).emit('display-content', content);
        console.log(`📤 Sent ${contentType || 'image'} to display ${serialNumber} (Device ID: ${deviceId})`);
        displaysSent++;
      }
    }
  } else {
    // Legacy: Send to all displays owned by this user
    for (const [serialNumber, displayInfo] of connectedDisplays.entries()) {
      if (displayInfo.userId === userId) {
        io.to(displayInfo.socketId).emit('display-content', content);
        console.log(`📤 Sent ${contentType || 'image'} to display ${serialNumber} (User: ${userId})`);
        displaysSent++;
      }
    }
  }

  if (displaysSent === 0) {
    console.warn('⚠️  No displays connected for user:', userId);
    return res.status(404).json({
      error: 'No displays connected',
      message: 'Please ensure your display is online and connected'
    });
  }

  // Log to display history
  try {
    await displayDb.create({
      imageUrl,
      imageTitle: imageTitle || null,
      displayedAt: now,
      duration: displayDuration,
      rotation: rotation || 0,
      mirror: mirror || false
    });
    console.log('✅ Display logged to history');
  } catch (error) {
    console.error('⚠️  Failed to log display:', error);
  }

  // Create schedule entries for Display Now
  try {
    if (groupId && uploadedFromGroup) {
      // Create schedule for each device in group
      for (const device of targetDevices) {
        const schedule = await scheduleDb.create({
          imageUrl,
          imageTitle: imageTitle || null,
          scheduledTime: scheduledTimeForDb,
          duration: displayDuration,
          repeat: 'once',
          rotation: rotation || 0,
          mirror: mirror || false,
          userId,
          contentType: contentType || 'image',
          videoFormat: videoFormat || null,
          videoResolution: videoResolution || null,
          videoSizeBytes: videoSizeBytes || null,
          videoDurationAuto: videoDurationAuto || null,
          thumbnailUrl: thumbnailUrl || null,
          userTimezone: device.device_timezone || userTz,
          deviceId: device.id,
          groupId: groupId,
          uploadedFromGroup: true
        });
        await scheduleDb.updateStatus(schedule.id, 'completed');
      }
      console.log(`✅ Created ${targetDevices.length} Display Now schedule entries for group ${groupId}`);
    } else {
      // Single device schedule
      const schedule = await scheduleDb.create({
        imageUrl,
        imageTitle: imageTitle || null,
        scheduledTime: scheduledTimeForDb,
        duration: displayDuration,
        repeat: 'once',
        rotation: rotation || 0,
        mirror: mirror || false,
        userId,
        contentType: contentType || 'image',
        videoFormat: videoFormat || null,
        videoResolution: videoResolution || null,
        videoSizeBytes: videoSizeBytes || null,
        videoDurationAuto: videoDurationAuto || null,
        thumbnailUrl: thumbnailUrl || null,
        userTimezone: userTz,
        deviceId: deviceId || null
      });
      await scheduleDb.updateStatus(schedule.id, 'completed');
      console.log('✅ Display Now schedule entry created:', schedule.id, 'at', scheduledTimeForDb, userTz);
    }
  } catch (error) {
    console.error('⚠️  Failed to create Display Now schedule entry:', error);
    // Don't fail the request if schedule creation fails
  }

  console.log(`✅ Content sent to ${displaysSent} display(s) for user ${userId}`);
  res.json({ success: true, displaysSent });
});

// Schedule content to device(s) or selection group
// NOTE: groupId refers to display_selection_groups (from "Select Device" screen)
// device_groups (from Settings "My Devices") are NOT used in scheduling
app.post('/api/schedule', authenticateToken, apiLimiter, async (req, res) => {
  const {
    imageUrl,
    imageTitle,
    scheduledTime,
    duration,
    repeat,
    rotation,
    mirror,
    contentType,
    videoFormat,
    videoResolution,
    videoSizeBytes,
    videoDurationAuto,
    thumbnailUrl,
    muted,
    userTimezone,
    deviceId,
    groupId,           // display_selection_groups.id (NOT device_groups.id)
    uploadedFromGroup
  } = req.body;
  const userId = req.user.userId;

  if (!imageUrl || !scheduledTime) {
    return res.status(400).json({ error: 'Content URL and scheduled time required' });
  }

  console.log('📅 Schedule creation request:', {
    scheduledTime,
    userTimezone: userTimezone || 'not provided',
    deviceId: deviceId || 'not provided',
    groupId: groupId || 'not provided',
    uploadedFromGroup: uploadedFromGroup || false,
    userId
  });

  try {
    console.log('🔍 DEBUG - Request body:', { groupId, uploadedFromGroup, deviceId, imageUrl: imageUrl?.substring(0, 50) });

    // If group upload, create schedule for each device in selection group
    // NOTE: groupId here refers to display_selection_groups (from "Select Device" screen)
    // This is SEPARATE from device_groups (used only in Settings "My Devices" for organization)
    if (groupId && uploadedFromGroup) {
      console.log('🔍 DEBUG - Entering group upload path');
      let groupDevices = [];
      let groupName = '';

      // Get devices from selection group (NOT device_group - that's only for Settings UI)
      try {
        console.log('🔍 DEBUG - Fetching selection group:', groupId, 'for user:', userId);
        const selectionGroupData = await displaySelectionGroups.getSelectionGroupWithDevices(groupId, userId);
        groupDevices = selectionGroupData.devices;
        groupName = selectionGroupData.group.group_name;
        console.log(`📍 Scheduling to selection group: "${groupName}" with ${groupDevices.length} devices`);
        console.log('🔍 DEBUG - Devices:', groupDevices.map(d => ({ id: d.id, name: d.device_name })));
      } catch (err) {
        console.error('❌ Failed to get selection group devices:', err);
        console.error('❌ Stack:', err.stack);
        return res.status(400).json({ error: 'Selection group not found or has no devices' });
      }

      if (groupDevices.length === 0) {
        console.error('❌ No devices in group');
        return res.status(400).json({ error: 'No devices in selection group' });
      }

      const createdSchedules = [];
      for (const device of groupDevices) {
        console.log(`🔍 DEBUG - Creating schedule for device ${device.id} (${device.device_name})`);
        try {
          // Create schedule for each device
          const schedule = await scheduleDb.create({
            imageUrl,
            imageTitle: imageTitle || null,
            scheduledTime,
            duration: duration || 60000,
            repeat: repeat || 'once',
            rotation: rotation || 0,
            mirror: mirror || false,
            userId,
            contentType: contentType || 'image',
            videoFormat: videoFormat || null,
            videoResolution: videoResolution || null,
            videoSizeBytes: videoSizeBytes || null,
            videoDurationAuto: videoDurationAuto || null,
            thumbnailUrl: thumbnailUrl || null,
            muted: muted || false,
            userTimezone: device.device_timezone || userTimezone || 'UTC',
            deviceId: device.id,
            groupId: groupId,
            uploadedFromGroup: true
          });
          console.log(`✅ Created schedule ${schedule.id} for device ${device.id}`);
          createdSchedules.push(schedule);
        } catch (scheduleErr) {
          console.error(`❌ Failed to create schedule for device ${device.id}:`, scheduleErr);
          console.error('❌ Stack:', scheduleErr.stack);
          throw scheduleErr; // Re-throw to be caught by outer catch
        }
      }

      console.log(`✅ Created ${createdSchedules.length} schedules for group ${groupId}`);
      return res.json({ success: true, schedules: createdSchedules, count: createdSchedules.length });
    }

    console.log('🔍 DEBUG - Entering single device path');

    // Single device schedule
    // Check for conflicts using database
    const hasConflict = await scheduleDb.hasConflict(scheduledTime, duration || 60000, userId);
    if (hasConflict) {
      return res.status(409).json({
        error: 'Schedule conflict detected',
        message: 'Another content is already scheduled for this time period'
      });
    }

    // Create schedule in database with user_id, timezone, device_id, and video metadata
    const schedule = await scheduleDb.create({
      imageUrl,
      imageTitle: imageTitle || null,
      scheduledTime,
      duration: duration || 60000,
      repeat: repeat || 'once',
      rotation: rotation || 0,
      mirror: mirror || false,
      userId,
      contentType: contentType || 'image',
      videoFormat: videoFormat || null,
      videoResolution: videoResolution || null,
      videoSizeBytes: videoSizeBytes || null,
      videoDurationAuto: videoDurationAuto || null,
      thumbnailUrl: thumbnailUrl || null,
      muted: muted || false,
      userTimezone: userTimezone || 'UTC',
      deviceId: deviceId || null,
      groupId: groupId || null,
      uploadedFromGroup: uploadedFromGroup || false
    });

    console.log('✅ Schedule created:', schedule.id, 'at', scheduledTime, userTimezone, 'for device:', deviceId);
    res.json({ success: true, schedule });
  } catch (error) {
    console.error('❌❌❌ ERROR CREATING SCHEDULE ❌❌❌');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Error details:', error);
    res.status(500).json({
      error: 'Failed to create schedule',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.get('/api/schedules', authenticateToken, apiLimiter, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { deviceId, groupId } = req.query;

    console.log('🔍 GET /api/schedules - userId:', userId, 'deviceId:', deviceId || 'none', 'groupId:', groupId || 'none');

    let schedules;

    if (deviceId) {
      // Get schedules for a specific device
      schedules = await scheduleDb.getForDevice(userId, parseInt(deviceId));
    } else if (groupId) {
      // Get schedules for all devices in a group
      schedules = await scheduleDb.getForGroup(userId, parseInt(groupId));
    } else {
      // Get all schedules for the user
      schedules = await scheduleDb.getAll(userId);
    }

    const filterDesc = deviceId ? ` for device ${deviceId}` : groupId ? ` for group ${groupId}` : ' (all)';
    console.log(`📊 Returning ${schedules.length} schedules${filterDesc}`);
    console.log('   Schedule details:', schedules.map(s => ({
      id: s.id,
      device_id: s.device_id,
      device_name: s.device_name,
      group_id: s.group_id
    })));

    res.json({ schedules });
  } catch (error) {
    console.error('Error fetching schedules:', error);
    res.status(500).json({ error: 'Failed to fetch schedules' });
  }
});

app.put('/api/schedule/:id', authenticateToken, apiLimiter, async (req, res) => {
  const { id } = req.params;
  const { scheduledTime, duration, repeat, imageTitle, userTimezone } = req.body;
  const userId = req.user.userId;

  console.log('📅 Schedule update request:', {
    id,
    scheduledTime,
    userTimezone: userTimezone || 'not provided',
    userId
  });

  try {
    // Check for conflicts (excluding this schedule)
    if (scheduledTime || duration) {
      const hasConflict = await scheduleDb.hasConflict(
        scheduledTime,
        duration,
        userId,
        id
      );
      if (hasConflict) {
        return res.status(409).json({
          error: 'Schedule conflict detected',
          message: 'Another image is already scheduled for this time period'
        });
      }
    }

    // Update schedule in database with user check
    const schedule = await scheduleDb.update(id, userId, {
      scheduledTime,
      duration,
      repeat,
      imageTitle,
      userTimezone
    });

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    console.log('Schedule updated:', schedule);

    // ✨ NEW: If schedule time is NOW or in the past, trigger it immediately
    const now = new Date();
    const scheduleTime = new Date(schedule.scheduled_time);

    if (scheduleTime <= now && schedule.status === 'pending') {
      console.log('🚀 Schedule time is NOW! Triggering immediate display...');

      const content = {
        type: schedule.content_type || 'image',
        url: schedule.image_url,
        duration: schedule.duration,
        rotation: schedule.rotation || 0,
        mirror: schedule.mirror || false,
        displayedAt: now,
        clearAt: new Date(now.getTime() + schedule.duration),
        thumbnailUrl: schedule.thumbnail_url || null,
        muted: schedule.muted || false
      };

      // Send to all displays owned by this user
      let displaysSent = 0;
      for (const [serialNumber, displayInfo] of connectedDisplays.entries()) {
        if (displayInfo.userId === userId) {
          io.to(displayInfo.socketId).emit('display-content', content);
          console.log(`📤 Sent ${content.type} to display ${serialNumber} (triggered by schedule update)`);
          displaysSent++;
        }
      }

      // Mark as completed
      await scheduleDb.updateStatus(schedule.id, 'completed');
      console.log(`✅ Triggered display on ${displaysSent} display(s)`);
    }

    res.json({ success: true, schedule });
  } catch (error) {
    console.error('Error updating schedule:', error);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

app.delete('/api/schedule/:id', authenticateToken, apiLimiter, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;

  try {
    const deletedSchedule = await scheduleDb.delete(id, userId);

    if (!deletedSchedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    // Check if this schedule is currently active (being displayed)
    const now = new Date();
    const scheduledTime = new Date(deletedSchedule.scheduled_time);
    const endTime = new Date(scheduledTime.getTime() + deletedSchedule.duration);
    const isActiveNow = now >= scheduledTime && now <= endTime;

    if (isActiveNow) {
      // Schedule is currently displaying - send clear signal to user's displays
      let displaysCleared = 0;
      for (const [serialNumber, displayInfo] of connectedDisplays.entries()) {
        if (displayInfo.userId === userId) {
          io.to(displayInfo.socketId).emit('clear-content');
          console.log(`🛑 Cleared active content on display ${serialNumber} (User: ${userId})`);
          displaysCleared++;
        }
      }
      console.log(`✅ Schedule deleted and cleared from ${displaysCleared} active display(s)`);
    } else {
      console.log('✅ Schedule deleted:', id);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting schedule:', error);
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
});

// Get user's devices with status
app.get('/api/user/devices', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get all devices for this user
    const devices = await devicePairing.getUserDevices(userId);

    // Enhance with connection status from connectedDisplays Map
    const devicesWithStatus = devices.map(device => {
      const isConnected = Array.from(connectedDisplays.values()).some(
        d => d.userId === userId && connectedDisplays.has(device.serial_number)
      );

      const connectionInfo = isConnected
        ? connectedDisplays.get(device.serial_number)
        : null;

      return {
        id: device.id,
        serialNumber: device.serial_number,
        deviceName: device.device_name,
        location: device.location,
        timezone: device.device_timezone || 'UTC',
        status: isConnected ? 'online' : 'offline',
        isPaired: device.is_paired,
        pairedAt: device.paired_at,
        lastSeen: device.last_seen,
        connectedAt: connectionInfo?.connectedAt || null,
        groupId: device.group_id || null // Include group_id for filtering
      };
    });

    console.log(`📱 Fetched ${devicesWithStatus.length} devices for user ${userId}`);

    // Debug: Log group_id for each device
    devicesWithStatus.forEach(d => {
      if (d.groupId) {
        console.log(`  Device ${d.deviceName} has groupId: ${d.groupId}`);
      }
    });

    res.json({ devices: devicesWithStatus });
  } catch (error) {
    console.error('Error fetching user devices:', error);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

// ═══════════════════════════════════════════════════════════
// DEVICE GROUPS API ENDPOINTS
// ═══════════════════════════════════════════════════════════

// Get all groups for user
app.get('/api/groups', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const groups = await deviceGroups.getUserGroups(userId);

    // Fetch devices for each group
    const groupsWithDevices = await Promise.all(
      groups.map(async (group) => {
        const groupWithDevices = await deviceGroups.getGroupWithDevices(group.id, userId);
        return {
          ...groupWithDevices,
          device_count: group.device_count // Keep the count from original query
        };
      })
    );

    console.log(`📁 Fetched ${groupsWithDevices.length} groups with devices for user ${userId}`);
    res.json({ groups: groupsWithDevices });
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// Get specific group with devices
app.get('/api/groups/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const groupId = req.params.id;
    const group = await deviceGroups.getGroupWithDevices(groupId, userId);

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    res.json({ group });
  } catch (error) {
    console.error('Error fetching group:', error);
    res.status(500).json({ error: 'Failed to fetch group' });
  }
});

// Create new group
app.post('/api/groups', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupName, color, icon, deviceIds } = req.body;

    if (!groupName) {
      return res.status(400).json({ error: 'Group name required' });
    }

    // Create group
    const group = await deviceGroups.createGroup(userId, groupName, color, icon);

    // Add devices if provided
    if (deviceIds && deviceIds.length > 0) {
      await deviceGroups.addDevicesToGroup(group.id, deviceIds);
    }

    console.log(`📁 Created group: ${groupName} with ${deviceIds?.length || 0} devices`);
    res.json({ success: true, group });
  } catch (error) {
    console.error('Error creating group:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// Update group
app.put('/api/groups/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const groupId = req.params.id;
    const updates = req.body;

    const group = await deviceGroups.updateGroup(groupId, userId, updates);

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    console.log(`📁 Updated group: ${group.group_name}`);
    res.json({ success: true, group });
  } catch (error) {
    console.error('Error updating group:', error);
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// Delete group
app.delete('/api/groups/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const groupId = req.params.id;

    const group = await deviceGroups.deleteGroup(groupId, userId);

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    console.log(`📁 Deleted group: ${group.group_name}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

// Add devices to group
app.post('/api/groups/:id/devices', authenticateToken, async (req, res) => {
  try {
    const groupId = req.params.id;
    const { deviceIds } = req.body;

    if (!deviceIds || deviceIds.length === 0) {
      return res.status(400).json({ error: 'Device IDs required' });
    }

    const members = await deviceGroups.addDevicesToGroup(groupId, deviceIds);

    console.log(`📁 Added ${deviceIds.length} devices to group ${groupId}`);
    res.json({ success: true, members });
  } catch (error) {
    console.error('Error adding devices to group:', error);
    res.status(500).json({ error: 'Failed to add devices to group' });
  }
});

// Remove device from group
app.delete('/api/groups/:groupId/devices/:deviceId', authenticateToken, async (req, res) => {
  try {
    const { groupId, deviceId } = req.params;

    const member = await deviceGroups.removeDeviceFromGroup(groupId, deviceId);

    if (!member) {
      return res.status(404).json({ error: 'Device not in group' });
    }

    console.log(`📁 Removed device ${deviceId} from group ${groupId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing device from group:', error);
    res.status(500).json({ error: 'Failed to remove device from group' });
  }
});

// ═══════════════════════════════════════════════════════════
// DISPLAY SELECTION GROUPS API ENDPOINTS
// (Separate from device_groups - used for Select Device navigation)
// ═══════════════════════════════════════════════════════════

// Get all selection groups for user
app.get('/api/selection-groups', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const groups = await displaySelectionGroups.getUserSelectionGroups(userId);
    const deviceIdsInGroups = await displaySelectionGroups.getDeviceIdsInSelectionGroups(userId);

    console.log(`📁 Fetched ${groups.length} selection groups for user ${userId}`);
    res.json({ groups, deviceIdsInGroups });
  } catch (error) {
    console.error('Error fetching selection groups:', error);
    res.status(500).json({ error: 'Failed to fetch selection groups' });
  }
});

// Get selection group with devices
app.get('/api/selection-groups/:groupId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupId } = req.params;

    const groupData = await displaySelectionGroups.getSelectionGroupWithDevices(groupId, userId);

    // Enhance devices with real-time connection status from connectedDisplays Map
    const devicesWithStatus = groupData.devices.map(device => {
      const isConnected = connectedDisplays.has(device.serial_number);

      return {
        ...device,
        status: isConnected ? 'online' : 'offline'
      };
    });

    console.log(`📁 Fetched selection group ${groupId} with ${devicesWithStatus.length} devices`);
    res.json({
      group: groupData.group,
      devices: devicesWithStatus
    });
  } catch (error) {
    console.error('Error fetching selection group:', error);
    res.status(500).json({ error: 'Failed to fetch selection group' });
  }
});

// Create new selection group
app.post('/api/selection-groups', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    const group = await displaySelectionGroups.createSelectionGroup(userId, name.trim());

    console.log(`📁 Created selection group: ${name}`);
    res.json({ group });
  } catch (error) {
    console.error('Error creating selection group:', error);
    res.status(500).json({ error: 'Failed to create selection group' });
  }
});

// Update selection group name
app.put('/api/selection-groups/:groupId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupId } = req.params;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    const group = await displaySelectionGroups.updateSelectionGroup(groupId, userId, name.trim());

    console.log(`📁 Updated selection group ${groupId} to: ${name}`);
    res.json({ group });
  } catch (error) {
    console.error('Error updating selection group:', error);
    res.status(500).json({ error: 'Failed to update selection group' });
  }
});

// Reorder selection groups
app.put('/api/selection-groups/reorder', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupIds } = req.body;

    console.log('📥 Received reorder request:', { userId, groupIds });

    if (!Array.isArray(groupIds)) {
      console.error('❌ groupIds is not an array:', typeof groupIds);
      return res.status(400).json({ error: 'groupIds must be an array' });
    }

    if (groupIds.length === 0) {
      console.warn('⚠️  Empty groupIds array received');
      return res.status(400).json({ error: 'groupIds array cannot be empty' });
    }

    // Update the display_order for each group
    for (let i = 0; i < groupIds.length; i++) {
      await pool.query(
        'UPDATE display_selection_groups SET display_order = $1 WHERE id = $2 AND user_id = $3',
        [i, groupIds[i], userId]
      );
    }

    console.log(`✅ Reordered ${groupIds.length} selection groups for user ${userId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error reordering selection groups:', error);
    res.status(500).json({ error: 'Failed to reorder groups' });
  }
});

// Delete selection group
app.delete('/api/selection-groups/:groupId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupId } = req.params;

    const group = await displaySelectionGroups.deleteSelectionGroup(groupId, userId);

    console.log(`📁 Deleted selection group ${groupId}`);
    res.json({ success: true, group });
  } catch (error) {
    console.error('Error deleting selection group:', error);
    res.status(500).json({ error: 'Failed to delete selection group' });
  }
});

// Add device to selection group
app.post('/api/selection-groups/:groupId/devices', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupId } = req.params;
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    const member = await displaySelectionGroups.addDeviceToSelectionGroup(groupId, deviceId, userId);

    console.log(`📁 Added device ${deviceId} to selection group ${groupId}`);
    res.json({ member });
  } catch (error) {
    console.error('Error adding device to selection group:', error);
    res.status(500).json({ error: 'Failed to add device to selection group' });
  }
});

// Remove device from selection group
app.delete('/api/selection-groups/:groupId/devices/:deviceId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { groupId, deviceId } = req.params;

    const member = await displaySelectionGroups.removeDeviceFromSelectionGroup(groupId, deviceId, userId);

    if (!member) {
      return res.status(404).json({ error: 'Device not in selection group' });
    }

    console.log(`📁 Removed device ${deviceId} from selection group ${groupId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing device from selection group:', error);
    res.status(500).json({ error: 'Failed to remove device from selection group' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Schedule checker - runs every 10 seconds
setInterval(async () => {
  const now = new Date();
  
  try {
    // Get all unique user IDs from connected displays
    const activeUserIds = new Set(
      Array.from(connectedDisplays.values()).map(d => d.userId)
    );
    
    // Process schedules for each active user separately
    for (const userId of activeUserIds) {
      const pendingSchedules = await scheduleDb.getPending(userId);
      
      for (const schedule of pendingSchedules) {
        const content = {
          type: schedule.content_type || 'image',
          url: schedule.image_url,
          duration: schedule.duration,
          rotation: schedule.rotation || 0,
          mirror: schedule.mirror || false,
          displayedAt: now,
          clearAt: new Date(now.getTime() + schedule.duration),
          thumbnailUrl: schedule.thumbnail_url || null,
          muted: schedule.muted || false
        };

        // Emit only to displays owned by this user
        for (const [serialNumber, displayInfo] of connectedDisplays.entries()) {
          if (displayInfo.userId === userId) {
            io.to(displayInfo.socketId).emit('display-content', content);
            console.log(`📤 Sent scheduled ${content.type} to display ${serialNumber} (User: ${userId})`);
          }
        }
        
        // Log to display history
        try {
          await displayDb.create({
            imageUrl: schedule.image_url,
            imageTitle: schedule.image_title || null,
            displayedAt: now,
            duration: schedule.duration,
            rotation: schedule.rotation || 0,
            mirror: schedule.mirror || false,
            scheduleId: schedule.id
          });
        } catch (dbError) {
          console.error('⚠️  Failed to log scheduled display:', dbError);
        }
        
        // Handle repeat schedules
        if (schedule.repeat_type === 'once') {
          await scheduleDb.updateStatus(schedule.id, 'completed');
        } else {
          // Calculate next occurrence
          const currentTime = new Date(schedule.scheduled_time);
          let nextTime;
          
          switch (schedule.repeat_type) {
            case 'daily':
              nextTime = new Date(currentTime.getTime() + 24 * 60 * 60 * 1000);
              break;
            case 'weekly':
              nextTime = new Date(currentTime.getTime() + 7 * 24 * 60 * 60 * 1000);
              break;
            case 'monthly':
              nextTime = new Date(currentTime.getTime() + 30 * 24 * 60 * 60 * 1000);
              break;
            case 'yearly':
              nextTime = new Date(currentTime.getTime() + 365 * 24 * 60 * 60 * 1000);
              break;
          }
          
          if (nextTime) {
            await scheduleDb.reschedule(schedule.id, nextTime);
          }
        }
        
        console.log('Displayed scheduled content:', schedule.id, 'for user:', userId);
      }
    }
  } catch (error) {
    console.error('Error in schedule checker:', error);
  }
  
  // Check if current content duration has expired (legacy - now per-user)
  if (currentContent && currentContent.clearAt && now >= new Date(currentContent.clearAt)) {
    console.log('Content duration expired, clearing display');
    currentContent = null;
    // Don't emit clear-content globally anymore - handled per display
    
    // Clear from database
    try {
      await currentDisplayDb.clear();
      console.log('✅ Cleared expired content from database');
    } catch (error) {
      console.error('⚠️  Failed to clear expired content from database:', error);
    }
  }
}, 10000);

// ═══════════════════════════════════════════════════════════
// SUBSCRIPTION TIER ROUTES
// ═══════════════════════════════════════════════════════════

// Device Sharing Routes (Pro tier)
const deviceSharingRoutes = require('./routes/deviceSharing');
app.use('/api/devices', deviceSharingRoutes);

// Playlist Routes (Pro tier)
const playlistRoutes = require('./routes/playlists');
app.use('/api/playlists', playlistRoutes);

// Organization Routes (Enterprise tier)
const organizationRoutes = require('./routes/organizations');
app.use('/api/organizations', organizationRoutes);

// Campaign Routes (Enterprise tier)
const campaignRoutes = require('./routes/campaigns');
app.use('/api/campaigns', campaignRoutes);

// Analytics Routes (Enterprise tier)
const analyticsRoutes = require('./routes/analytics');
app.use('/api/analytics', analyticsRoutes);

// Subscription Management Routes
const subscriptionRoutes = require('./routes/subscriptions');
app.use('/api/subscriptions', subscriptionRoutes);

// Device Auto-Pairing Routes (for Raspberry Pi kiosks)
const deviceAutoPairingRoutes = require('./routes/deviceAutoPairing');
app.use('/api/devices/auto-pair', deviceAutoPairingRoutes);

console.log('✅ All subscription tier routes loaded');

// ============================================
// LIVE VIDEO ANNOUNCEMENT ROUTES
// ============================================
console.log('📡 Setting up live video announcement routes...');
setupLiveSessionRoutes(app, authenticateToken, apiLimiter);

// ============================================
// LIVE VIDEO ANNOUNCEMENT SIGNALING
// ============================================
console.log('🎥 Setting up live video signaling...');
const liveSignaling = setupLiveSignaling(io);

// Store signaling helpers globally (for admin features)
global.liveSignalingHelpers = liveSignaling;

console.log('✅ Live video announcement system ready!');

// Initialize Firebase Cloud Messaging (Push Notifications)
console.log('🔥 Initializing Firebase Cloud Messaging...');
initializeFirebase();

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
