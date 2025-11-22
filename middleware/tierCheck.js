/**
 * Subscription Tier Middleware
 * Controls access to features based on user's subscription tier
 */

const tierLevels = {
  basic: 1,
  pro: 2,
  enterprise: 3
};

/**
 * Middleware to require a minimum subscription tier
 * @param {string} minimumTier - Required tier ('basic', 'pro', or 'enterprise')
 * @returns {Function} Express middleware
 */
const requireTier = (minimumTier) => {
  return async (req, res, next) => {
    try {
      const user = req.user;

      if (!user) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'You must be logged in to access this feature'
        });
      }

      // Get user's current tier (defaults to 'basic' if not set)
      const userTier = user.subscription_tier || 'basic';
      const userLevel = tierLevels[userTier] || 1;
      const requiredLevel = tierLevels[minimumTier] || 1;

      // Check if user has sufficient tier
      if (userLevel < requiredLevel) {
        return res.status(403).json({
          error: 'Upgrade required',
          message: `This feature requires ${minimumTier} tier subscription`,
          currentTier: userTier,
          requiredTier: minimumTier,
          upgradeUrl: '/api/subscriptions/upgrade-options'
        });
      }

      // User has access, continue
      next();
    } catch (error) {
      console.error('Error in tier check middleware:', error);
      res.status(500).json({ error: 'Failed to verify subscription tier' });
    }
  };
};

/**
 * Check if user can share devices (Pro+ feature)
 */
const canShareDevices = (req, res, next) => {
  return requireTier('pro')(req, res, next);
};

/**
 * Check if user can create playlists (Pro+ feature)
 */
const canCreatePlaylists = (req, res, next) => {
  return requireTier('pro')(req, res, next);
};

/**
 * Check if user can access organizations (Enterprise feature)
 */
const canAccessOrganizations = (req, res, next) => {
  return requireTier('enterprise')(req, res, next);
};

/**
 * Check if user can create campaigns (Enterprise feature)
 */
const canCreateCampaigns = (req, res, next) => {
  return requireTier('enterprise')(req, res, next);
};

/**
 * Check if user can access analytics (Enterprise feature)
 */
const canAccessAnalytics = (req, res, next) => {
  return requireTier('enterprise')(req, res, next);
};

/**
 * Check storage limits based on tier
 * @param {number} fileSize - Size of file being uploaded in bytes
 * @param {object} user - User object with subscription_tier
 * @returns {object} { allowed: boolean, message: string }
 */
const checkStorageLimit = async (fileSize, user, pool) => {
  const storageLimits = {
    basic: 1 * 1024 * 1024 * 1024,      // 1GB
    pro: 50 * 1024 * 1024 * 1024,       // 50GB
    enterprise: 500 * 1024 * 1024 * 1024 // 500GB
  };

  const tier = user.subscription_tier || 'basic';
  const limit = storageLimits[tier];
  const currentUsage = user.storage_used_bytes || 0;

  if (currentUsage + fileSize > limit) {
    return {
      allowed: false,
      message: `Storage limit exceeded. Used: ${formatBytes(currentUsage)} / ${formatBytes(limit)}`,
      currentUsage,
      limit,
      tier,
      upgradeRequired: true
    };
  }

  return {
    allowed: true,
    currentUsage,
    limit,
    remaining: limit - currentUsage
  };
};

/**
 * Check file size limits based on tier
 * @param {number} fileSize - Size of file in bytes
 * @param {string} fileType - 'image' or 'video'
 * @param {object} user - User object with subscription_tier
 * @returns {object} { allowed: boolean, message: string }
 */
const checkFileSizeLimit = (fileSize, fileType, user) => {
  const tier = user.subscription_tier || 'basic';

  const fileSizeLimits = {
    basic: {
      image: 10 * 1024 * 1024,  // 10MB
      video: 100 * 1024 * 1024  // 100MB (Basic now supports video!)
    },
    pro: {
      image: 50 * 1024 * 1024,  // 50MB
      video: 100 * 1024 * 1024  // 100MB
    },
    enterprise: {
      image: 100 * 1024 * 1024, // 100MB
      video: 500 * 1024 * 1024  // 500MB
    }
  };

  const limit = fileSizeLimits[tier][fileType];

  if (fileSize > limit) {
    return {
      allowed: false,
      message: `File too large. Maximum ${fileType} size for ${tier} tier: ${formatBytes(limit)}`,
      fileSize,
      limit,
      tier,
      upgradeRequired: tier !== 'enterprise'
    };
  }

  return {
    allowed: true,
    fileSize,
    limit
  };
};

/**
 * Track storage usage after upload
 */
const trackStorageUsage = async (userId, fileSize, pool) => {
  try {
    await pool.query(`
      UPDATE users
      SET storage_used_bytes = storage_used_bytes + $1
      WHERE id = $2
    `, [fileSize, userId]);
  } catch (error) {
    console.error('Error tracking storage usage:', error);
  }
};

/**
 * Release storage after file deletion
 */
const releaseStorage = async (userId, fileSize, pool) => {
  try {
    await pool.query(`
      UPDATE users
      SET storage_used_bytes = GREATEST(0, storage_used_bytes - $1)
      WHERE id = $2
    `, [fileSize, userId]);
  } catch (error) {
    console.error('Error releasing storage:', error);
  }
};

/**
 * Format bytes to human-readable format
 */
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

/**
 * Get tier features for display in UI
 */
const getTierFeatures = (tier) => {
  const features = {
    basic: {
      tier: 'basic',
      name: 'Basic',
      price: 'Free',
      features: [
        'Unlimited schedules',
        'Unlimited devices',
        'Display Now',
        'Simple scheduling',
        'Device groups',
        'Video support',
        'Time range scheduling',
        '1GB storage'
      ],
      limits: {
        storage: '1GB',
        imageSize: '10MB',
        videoSize: '100MB'
      }
    },
    pro: {
      tier: 'pro',
      name: 'Pro',
      price: '$19/month',
      features: [
        'Everything in Basic',
        'Device sharing',
        'Permission levels',
        'Playlists',
        'Priority levels',
        'Schedule templates',
        'Exclude dates',
        '50GB storage'
      ],
      limits: {
        storage: '50GB',
        imageSize: '50MB',
        videoSize: '100MB'
      }
    },
    enterprise: {
      tier: 'enterprise',
      name: 'Enterprise',
      price: '$99/month',
      features: [
        'Everything in Pro',
        'Organizations',
        'Bulk operations',
        'Campaigns',
        'Approval workflows',
        'Usage analytics',
        'Audit logs',
        'Priority support',
        '500GB storage'
      ],
      limits: {
        storage: '500GB',
        imageSize: '100MB',
        videoSize: '500MB'
      }
    }
  };

  return features[tier] || features.basic;
};

module.exports = {
  requireTier,
  canShareDevices,
  canCreatePlaylists,
  canAccessOrganizations,
  canCreateCampaigns,
  canAccessAnalytics,
  checkStorageLimit,
  checkFileSizeLimit,
  trackStorageUsage,
  releaseStorage,
  formatBytes,
  getTierFeatures,
  tierLevels
};
