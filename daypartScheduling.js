const cron = require('node-cron');
const db = require('./database');

// Daypart configuration
const DAYPARTS = {
  BREAKFAST: { start: '06:00', end: '11:00', name: 'Breakfast' },
  LUNCH: { start: '11:00', end: '16:00', name: 'Lunch' },
  DINNER: { start: '16:00', end: '22:00', name: 'Dinner' },
  LATE_NIGHT: { start: '22:00', end: '06:00', name: 'Late Night' }
};

// Get current daypart based on time
function getCurrentDaypart() {
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  for (const [key, daypart] of Object.entries(DAYPARTS)) {
    // Handle late night (crosses midnight)
    if (key === 'LATE_NIGHT') {
      if (currentTime >= daypart.start || currentTime < daypart.end) {
        return { type: key, ...daypart };
      }
    } else {
      if (currentTime >= daypart.start && currentTime < daypart.end) {
        return { type: key, ...daypart };
      }
    }
  }

  return { type: 'UNKNOWN', name: 'Unknown', start: '', end: '' };
}

// Get devices with daypart scheduling enabled
async function getDevicesWithDaypartScheduling() {
  try {
    const result = await db.query(
      `SELECT DISTINCT device_id, device_name
       FROM devices
       WHERE daypart_enabled = true AND is_paired = true`
    );
    return result.rows;
  } catch (error) {
    console.error('❌ Failed to get devices with daypart scheduling:', error);
    return [];
  }
}

// Get content for a specific daypart
async function getContentForDaypart(deviceId, daypartType) {
  try {
    const result = await db.query(
      `SELECT * FROM daypart_content
       WHERE device_id = $1 AND daypart_type = $2
       ORDER BY priority ASC
       LIMIT 1`,
      [deviceId, daypartType]
    );

    if (result.rows.length > 0) {
      return result.rows[0];
    }

    // Fallback to default content
    const defaultResult = await db.query(
      `SELECT * FROM media
       WHERE user_id = (SELECT user_id FROM devices WHERE device_id = $1)
       AND is_default = true
       LIMIT 1`,
      [deviceId]
    );

    return defaultResult.rows[0] || null;
  } catch (error) {
    console.error('❌ Failed to get daypart content:', error);
    return null;
  }
}

// Apply daypart scheduling to device
async function applyDaypartSchedule(deviceId, daypart, io) {
  try {
    const content = await getContentForDaypart(deviceId, daypart.type);

    if (content) {
      console.log(`📅 [Daypart] Switching device ${deviceId} to ${daypart.name} content`);

      // Get device info to find socket
      const deviceResult = await db.query(
        'SELECT serial_number FROM devices WHERE device_id = $1',
        [deviceId]
      );

      if (deviceResult.rows.length > 0) {
        const serialNumber = deviceResult.rows[0].serial_number;

        // Emit content change via Socket.IO
        io.to(serialNumber).emit('display-content', {
          url: content.cloudinary_url || content.url,
          type: content.type,
          rotation: content.rotation || 0,
          mirror: content.mirror || false,
          duration: content.duration || 10000,
          daypart: daypart.name
        });

        // Log the daypart change
        await db.query(
          `INSERT INTO daypart_logs (device_id, daypart_type, content_id, applied_at)
           VALUES ($1, $2, $3, NOW())`,
          [deviceId, daypart.type, content.id || content.media_id]
        );

        console.log(`✅ [Daypart] Successfully applied ${daypart.name} to device ${deviceId}`);
      }
    } else {
      console.log(`⚠️ [Daypart] No content found for device ${deviceId} daypart ${daypart.name}`);
    }
  } catch (error) {
    console.error(`❌ [Daypart] Failed to apply schedule to device ${deviceId}:`, error);
  }
}

// Check and apply daypart schedules for all devices
async function checkAndApplyDayparts(io) {
  const currentDaypart = getCurrentDaypart();
  console.log(`🕐 [Daypart Check] Current daypart: ${currentDaypart.name} (${currentDaypart.start} - ${currentDaypart.end})`);

  const devices = await getDevicesWithDaypartScheduling();
  console.log(`📱 [Daypart] Found ${devices.length} devices with daypart scheduling enabled`);

  for (const device of devices) {
    await applyDaypartSchedule(device.device_id, currentDaypart, io);
  }
}

// Initialize daypart scheduling with cron jobs
function initializeDaypartScheduling(io) {
  console.log('🚀 [Daypart] Initializing daypart scheduling system...');

  // Check dayparts every 10 minutes
  cron.schedule('*/10 * * * *', () => {
    console.log('⏰ [Daypart] Running scheduled daypart check...');
    checkAndApplyDayparts(io);
  });

  // Also check at the start of each daypart
  cron.schedule('0 6,11,16,22 * * *', () => {
    console.log('🔔 [Daypart] Daypart transition detected!');
    checkAndApplyDayparts(io);
  });

  // Run initial check
  checkAndApplyDayparts(io);

  console.log('✅ [Daypart] Daypart scheduling system initialized');
}

module.exports = {
  getCurrentDaypart,
  getDevicesWithDaypartScheduling,
  getContentForDaypart,
  applyDaypartSchedule,
  checkAndApplyDayparts,
  initializeDaypartScheduling,
  DAYPARTS
};
