/**
 * Display Information Routes
 *
 * Handles EDID (Extended Display Identification Data) from SmartStick devices
 *
 * EDID provides automatic display detection:
 * - Resolution (1920x1080, 3840x2160, etc.)
 * - Physical size (43", 55", etc.)
 * - Manufacturer (Samsung, LG, etc.)
 * - Refresh rate (60Hz, 120Hz, etc.)
 *
 * Flow:
 * 1. SmartStick boots and plugs into display via HDMI
 * 2. SmartStick reads EDID data from display via I2C bus
 * 3. SmartStick POSTs data to /api/devices/:id/display-info
 * 4. Server stores display info in database
 * 5. Mobile app GETs display info to show user
 * 6. App uses display info to recommend optimal upload settings
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../authMiddleware');

module.exports = (db) => {
  /**
   * POST /api/devices/:deviceId/display-info
   *
   * Called by SmartStick device after reading EDID data from connected display
   *
   * Request body:
   * {
   *   "native_resolution": "1920x1080",
   *   "width": 1920,
   *   "height": 1080,
   *   "aspect_ratio": "16:9",
   *   "refresh_rate": 60,
   *   "size_inches": 43,
   *   "manufacturer": "Samsung",
   *   "model": "UN43TU7000",
   *   "edid_raw": {...}  // Optional: raw EDID data for debugging
   * }
   */
  router.post('/devices/:deviceId/display-info', authenticateToken, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const {
        native_resolution,
        width,
        height,
        aspect_ratio,
        refresh_rate,
        size_inches,
        manufacturer,
        model,
        edid_raw
      } = req.body;

      console.log(`📺 Received display info for device ${deviceId}:`, {
        resolution: native_resolution,
        manufacturer,
        model
      });

      // Validate device exists and belongs to user
      const deviceCheck = await db.query(
        'SELECT id, user_id FROM devices WHERE id = $1',
        [deviceId]
      );

      if (deviceCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Device not found'
        });
      }

      // For now, skip user_id check if devices table doesn't have it yet
      // TODO: Uncomment when devices table has user_id column
      // if (deviceCheck.rows[0].user_id !== req.user.id) {
      //   return res.status(403).json({
      //     success: false,
      //     error: 'Not authorized to update this device'
      //   });
      // }

      // Update display information
      const result = await db.query(`
        UPDATE displays
        SET
          display_resolution = $1,
          display_width = $2,
          display_height = $3,
          display_aspect_ratio = $4,
          display_refresh_rate = $5,
          display_size_inches = $6,
          display_manufacturer = $7,
          display_model = $8,
          display_info_updated_at = CURRENT_TIMESTAMP,
          edid_data = $9
        WHERE id = $10
        RETURNING *
      `, [
        native_resolution,
        width,
        height,
        aspect_ratio,
        refresh_rate,
        size_inches,
        manufacturer,
        model,
        edid_raw ? JSON.stringify(edid_raw) : null,
        deviceId
      ]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Failed to update device'
        });
      }

      console.log(`✅ Updated display info for device ${deviceId}`);

      res.json({
        success: true,
        message: 'Display information updated',
        display_info: {
          resolution: native_resolution,
          width,
          height,
          aspect_ratio,
          refresh_rate,
          size_inches,
          manufacturer,
          model,
          updated_at: result.rows[0].display_info_updated_at
        }
      });

    } catch (error) {
      console.error('❌ Error updating display info:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update display information',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  /**
   * GET /api/devices/:deviceId/display-info
   *
   * Get display information for a specific device
   * Used by mobile app to show user what display their SmartStick is connected to
   */
  router.get('/devices/:deviceId/display-info', authenticateToken, async (req, res) => {
    try {
      const { deviceId } = req.params;

      // Get display information
      const result = await db.query(`
        SELECT
          id,
          display_name,
          display_resolution,
          display_width,
          display_height,
          display_aspect_ratio,
          display_refresh_rate,
          display_size_inches,
          display_manufacturer,
          display_model,
          display_info_updated_at,
          status,
          last_seen
        FROM displays
        WHERE id = $1
      `, [deviceId]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Device not found'
        });
      }

      const device = result.rows[0];

      // Check if display info has been populated
      const hasDisplayInfo = device.display_resolution !== null;

      res.json({
        success: true,
        device: {
          id: device.id,
          name: device.display_name,
          status: device.status,
          last_seen: device.last_seen,
          display_info: hasDisplayInfo ? {
            resolution: device.display_resolution,
            width: device.display_width,
            height: device.display_height,
            aspect_ratio: device.display_aspect_ratio,
            refresh_rate: device.display_refresh_rate,
            size_inches: device.display_size_inches,
            manufacturer: device.display_manufacturer,
            model: device.display_model,
            updated_at: device.display_info_updated_at,
            // Provide helpful recommendations
            recommended_image_size: `${device.display_width}x${device.display_height}`,
            recommended_video_format: device.display_width >= 3840 ? '4K (3840x2160)' : '1080p (1920x1080)'
          } : null
        }
      });

    } catch (error) {
      console.error('❌ Error fetching display info:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch display information',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  /**
   * GET /api/user/devices-with-display-info
   *
   * Get all devices for current user with their display information
   * Useful for showing overview of all connected SmartSticks
   */
  router.get('/user/devices-with-display-info', authenticateToken, async (req, res) => {
    try {
      // For now, get all displays since devices table doesn't have user_id yet
      // TODO: Add WHERE user_id = $1 when devices table is updated
      const result = await db.query(`
        SELECT
          id,
          display_name,
          display_resolution,
          display_width,
          display_height,
          display_aspect_ratio,
          display_refresh_rate,
          display_size_inches,
          display_manufacturer,
          display_model,
          display_info_updated_at,
          status,
          last_seen,
          created_at
        FROM displays
        ORDER BY created_at DESC
      `);

      const devices = result.rows.map(device => ({
        id: device.id,
        name: device.display_name,
        status: device.status,
        last_seen: device.last_seen,
        created_at: device.created_at,
        display_info: device.display_resolution ? {
          resolution: device.display_resolution,
          width: device.display_width,
          height: device.display_height,
          aspect_ratio: device.display_aspect_ratio,
          refresh_rate: device.display_refresh_rate,
          size_inches: device.display_size_inches,
          manufacturer: device.display_manufacturer,
          model: device.display_model,
          display_summary: `${device.display_manufacturer || 'Unknown'} ${device.display_size_inches ? device.display_size_inches + '"' : ''} (${device.display_resolution || 'Unknown'})`,
          updated_at: device.display_info_updated_at
        } : null
      }));

      res.json({
        success: true,
        count: devices.length,
        devices
      });

    } catch (error) {
      console.error('❌ Error fetching devices with display info:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch devices',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  return router;
};
