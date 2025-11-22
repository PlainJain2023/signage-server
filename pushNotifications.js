// Firebase Cloud Messaging (FCM) for push notifications
const admin = require('firebase-admin');
const db = require('./database');

// Initialize Firebase Admin SDK
// Note: In production, you'll need to add your Firebase service account JSON file
let firebaseInitialized = false;

function initializeFirebase() {
  try {
    // Check if service account file exists
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './firebase-service-account.json';

    if (require('fs').existsSync(serviceAccountPath)) {
      const serviceAccount = require(serviceAccountPath);

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID
      });

      firebaseInitialized = true;
      console.log('✅ Firebase Cloud Messaging initialized');
    } else {
      console.warn('⚠️ Firebase service account file not found. Push notifications disabled.');
      console.warn('   To enable: Add firebase-service-account.json to server directory');
    }
  } catch (error) {
    console.error('❌ Failed to initialize Firebase:', error.message);
    console.warn('   Push notifications will be disabled');
  }
}

// Save device FCM token
async function saveDeviceToken(userId, deviceId, fcmToken) {
  try {
    await db.query(
      `INSERT INTO device_tokens (user_id, device_id, fcm_token, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (device_id)
       DO UPDATE SET fcm_token = $3, updated_at = NOW()`,
      [userId, deviceId, fcmToken]
    );
    console.log(`✅ Saved FCM token for device ${deviceId}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to save FCM token:', error);
    return false;
  }
}

// Remove device token (on logout or token revocation)
async function removeDeviceToken(deviceId) {
  try {
    await db.query('DELETE FROM device_tokens WHERE device_id = $1', [deviceId]);
    console.log(`✅ Removed FCM token for device ${deviceId}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to remove FCM token:', error);
    return false;
  }
}

// Get all tokens for a user
async function getUserTokens(userId) {
  try {
    const result = await db.query(
      'SELECT fcm_token FROM device_tokens WHERE user_id = $1',
      [userId]
    );
    return result.rows.map(row => row.fcm_token);
  } catch (error) {
    console.error('❌ Failed to get user tokens:', error);
    return [];
  }
}

// Send notification to a single device
async function sendNotificationToDevice(fcmToken, notification, data = {}) {
  if (!firebaseInitialized) {
    console.warn('⚠️ Firebase not initialized, skipping notification');
    return { success: false, error: 'Firebase not initialized' };
  }

  try {
    const message = {
      token: fcmToken,
      notification: {
        title: notification.title,
        body: notification.body,
        imageUrl: notification.imageUrl
      },
      data: data,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1
          }
        }
      }
    };

    const response = await admin.messaging().send(message);
    console.log('✅ Successfully sent notification:', response);
    return { success: true, response };
  } catch (error) {
    console.error('❌ Failed to send notification:', error);
    return { success: false, error: error.message };
  }
}

// Send notification to multiple devices (user's devices)
async function sendNotificationToUser(userId, notification, data = {}) {
  if (!firebaseInitialized) {
    console.warn('⚠️ Firebase not initialized, skipping notification');
    return { success: false, error: 'Firebase not initialized' };
  }

  try {
    const tokens = await getUserTokens(userId);

    if (tokens.length === 0) {
      console.warn(`⚠️ No FCM tokens found for user ${userId}`);
      return { success: false, error: 'No tokens found' };
    }

    const message = {
      tokens: tokens,
      notification: {
        title: notification.title,
        body: notification.body,
        imageUrl: notification.imageUrl
      },
      data: data,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1
          }
        }
      }
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`✅ Sent notifications to ${response.successCount}/${tokens.length} devices`);

    // Remove invalid tokens
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success && resp.error.code === 'messaging/invalid-registration-token') {
          console.log(`🗑️ Removing invalid token: ${tokens[idx]}`);
          // Remove from database
          db.query('DELETE FROM device_tokens WHERE fcm_token = $1', [tokens[idx]]);
        }
      });
    }

    return { success: true, response };
  } catch (error) {
    console.error('❌ Failed to send notifications:', error);
    return { success: false, error: error.message };
  }
}

// Predefined notification templates
const NotificationTemplates = {
  SCHEDULE_UPDATED: (deviceName) => ({
    title: '📅 Schedule Updated',
    body: `Your display "${deviceName}" has a new schedule`
  }),

  CONTENT_UPLOADED: (fileName) => ({
    title: '📷 New Content Uploaded',
    body: `${fileName} is ready to use`
  }),

  DEVICE_OFFLINE: (deviceName) => ({
    title: '🔴 Device Offline',
    body: `${deviceName} has disconnected`
  }),

  DEVICE_ONLINE: (deviceName) => ({
    title: '🟢 Device Online',
    body: `${deviceName} is back online`
  }),

  LIVE_VIDEO_STARTED: (deviceName) => ({
    title: '🎥 Live Video Started',
    body: `Broadcasting to ${deviceName}`
  }),

  PAIRING_SUCCESSFUL: (deviceName) => ({
    title: '✅ Device Paired',
    body: `${deviceName} is now connected`
  }),

  DAYPART_CHANGED: (daypartName, deviceName) => ({
    title: `🕐 ${daypartName} Menu Active`,
    body: `${deviceName} switched to ${daypartName} content`
  })
};

// Send template notification
async function sendTemplateNotification(userId, templateName, ...args) {
  const template = NotificationTemplates[templateName];

  if (!template) {
    console.error(`❌ Unknown notification template: ${templateName}`);
    return { success: false, error: 'Unknown template' };
  }

  const notification = template(...args);
  return await sendNotificationToUser(userId, notification, {
    template: templateName,
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  initializeFirebase,
  saveDeviceToken,
  removeDeviceToken,
  getUserTokens,
  sendNotificationToDevice,
  sendNotificationToUser,
  sendTemplateNotification,
  NotificationTemplates
};
