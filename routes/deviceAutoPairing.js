const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const {
  createDevice,
  getDeviceBySerial,
  getDeviceByPairingCode,
  verifyPairingCode,
  pairDeviceToUser,
  setDeviceSyncing
} = require('../devicePairing');
const { authenticateToken } = require('../authMiddleware');

/**
 * AUTO-PAIRING FLOW FOR RASPBERRY PI DEVICES
 *
 * 1. Pi registers itself → gets pairing code
 * 2. Pi shows QR code with pairing URL
 * 3. User scans QR → mobile app opens
 * 4. Mobile app confirms pairing → device is paired
 * 5. Pi polls for pairing status → gets confirmed → loads display
 */

// Step 1: Pi registers itself and gets a pairing code
router.post('/register', async (req, res) => {
  try {
    const {
      serialNumber, // Unique Pi identifier (MAC address, CPU serial, etc.)
      deviceName,
      buildNumber,
      firmwareVersion,
      macAddress,
      ipAddress
    } = req.body;

    console.log('📱 Device registration request:', {
      serialNumber,
      deviceName,
      ipAddress
    });

    // Check if device already exists
    let device = await getDeviceBySerial(serialNumber);

    if (device) {
      // Device exists - check if already paired
      if (device.is_paired) {
        console.log('✅ Device already paired:', serialNumber);
        return res.json({
          success: true,
          alreadyPaired: true,
          device: {
            serial_number: device.serial_number,
            device_name: device.device_name,
            is_paired: device.is_paired,
            user_id: device.user_id
          }
        });
      }

      // Device exists but not paired - return existing pairing code
      console.log('🔄 Device exists but not paired, returning existing code:', device.pairing_code);
      return res.json({
        success: true,
        device: {
          serial_number: device.serial_number,
          pairing_code: device.pairing_code,
          device_name: device.device_name,
          is_paired: false
        }
      });
    }

    // Create new device
    device = await createDevice({
      serialNumber,
      deviceName: deviceName || 'SmartStick Pro',
      buildNumber: buildNumber || '1.0.0',
      firmwareVersion: firmwareVersion || '2025.11.20'
    });

    console.log('✅ New device created:', {
      serial: device.serial_number,
      pairing_code: device.pairing_code
    });

    res.json({
      success: true,
      device: {
        serial_number: device.serial_number,
        pairing_code: device.pairing_code,
        device_name: device.device_name,
        is_paired: false,
        pairing_code_expires_at: device.pairing_code_expires_at
      }
    });

  } catch (error) {
    console.error('❌ Error registering device:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to register device',
      message: error.message
    });
  }
});

// Step 2: Get QR code for pairing (used by display app)
router.get('/qr/:pairingCode', async (req, res) => {
  try {
    const { pairingCode } = req.params;

    // Verify the pairing code exists
    const device = await getDeviceByPairingCode(pairingCode);
    if (!device) {
      return res.status(404).json({
        success: false,
        error: 'Invalid pairing code'
      });
    }

    // Generate QR code URL that mobile app will scan
    // This URL will open the mobile app and trigger pairing
    const pairingUrl = `smartstickpro://pair?code=${pairingCode}`;

    // Generate QR code image
    const qrCodeDataUrl = await QRCode.toDataURL(pairingUrl, {
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    res.json({
      success: true,
      qrCode: qrCodeDataUrl,
      pairingCode: pairingCode,
      pairingUrl: pairingUrl
    });

  } catch (error) {
    console.error('❌ Error generating QR code:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate QR code',
      message: error.message
    });
  }
});

// Step 3: Check if device is paired (Pi polls this)
router.get('/status/:serialNumber', async (req, res) => {
  try {
    const { serialNumber } = req.params;

    const device = await getDeviceBySerial(serialNumber);

    if (!device) {
      return res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }

    res.json({
      success: true,
      device: {
        serial_number: device.serial_number,
        is_paired: device.is_paired,
        status: device.status,
        pairing_code: device.is_paired ? null : device.pairing_code,
        user_id: device.user_id,
        device_name: device.device_name
      }
    });

  } catch (error) {
    console.error('❌ Error checking device status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check device status',
      message: error.message
    });
  }
});

// Step 4: Mobile app confirms pairing (requires auth)
router.post('/confirm', authenticateToken, async (req, res) => {
  try {
    const { pairingCode, location } = req.body;
    const userId = req.user.userId;

    console.log('📱 Pairing confirmation:', {
      pairingCode,
      userId,
      location
    });

    // Verify pairing code
    const verification = await verifyPairingCode(pairingCode);
    if (!verification.valid) {
      console.log('❌ Invalid pairing code:', pairingCode);
      return res.status(400).json({
        success: false,
        error: verification.reason
      });
    }

    const device = verification.device;

    // Set device to syncing state
    await setDeviceSyncing(device.id);

    // Pair device to user
    const pairedDevice = await pairDeviceToUser(device.id, userId, location);

    console.log('✅ Device paired successfully:', {
      serial: pairedDevice.serial_number,
      userId: userId
    });

    res.json({
      success: true,
      message: 'Device paired successfully',
      device: {
        id: pairedDevice.id,
        serial_number: pairedDevice.serial_number,
        device_name: pairedDevice.device_name,
        location: pairedDevice.location,
        paired_at: pairedDevice.paired_at
      }
    });

  } catch (error) {
    console.error('❌ Error confirming pairing:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to confirm pairing',
      message: error.message
    });
  }
});

// Get pairing info by code (for display screen)
router.get('/info/:pairingCode', async (req, res) => {
  try {
    const { pairingCode } = req.params;

    const device = await getDeviceByPairingCode(pairingCode);
    if (!device) {
      return res.status(404).json({
        success: false,
        error: 'Invalid pairing code'
      });
    }

    res.json({
      success: true,
      device: {
        pairing_code: device.pairing_code,
        device_name: device.device_name,
        is_paired: device.is_paired,
        status: device.status,
        expires_at: device.pairing_code_expires_at
      }
    });

  } catch (error) {
    console.error('❌ Error getting pairing info:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get pairing info',
      message: error.message
    });
  }
});

module.exports = router;
