/**
 * Subscription Management Routes
 * Handles subscription plans, upgrades, and usage tracking
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');
const { getTierFeatures, formatBytes } = require('../middleware/tierCheck');

// ═══════════════════════════════════════════════════════════
// SUBSCRIPTION ENDPOINTS
// ═══════════════════════════════════════════════════════════

/**
 * Get available subscription plans
 * GET /api/subscriptions/plans
 */
router.get('/plans', async (req, res) => {
  try {
    const plans = [
      {
        tier: 'basic',
        ...getTierFeatures('basic'),
        price: 0,
        priceDisplay: 'Free',
        features: getTierFeatures('basic').features
      },
      {
        tier: 'pro',
        ...getTierFeatures('pro'),
        price: 19,
        priceDisplay: '$19/month',
        features: getTierFeatures('pro').features
      },
      {
        tier: 'enterprise',
        ...getTierFeatures('enterprise'),
        price: 99,
        priceDisplay: '$99/month',
        features: getTierFeatures('enterprise').features
      }
    ];

    res.json({
      success: true,
      plans
    });

  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

/**
 * Get current subscription for user
 * GET /api/subscriptions/current
 */
router.get('/current', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(`
      SELECT
        u.subscription_tier,
        u.subscription_status,
        u.subscription_started_at,
        u.subscription_renews_at,
        u.storage_used_bytes,
        s.*
      FROM users u
      LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active'
      WHERE u.id = $1
      ORDER BY s.started_at DESC
      LIMIT 1
    `, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const tierInfo = getTierFeatures(user.subscription_tier || 'basic');

    res.json({
      success: true,
      subscription: {
        tier: user.subscription_tier || 'basic',
        status: user.subscription_status || 'active',
        startedAt: user.subscription_started_at,
        renewsAt: user.subscription_renews_at,
        tierInfo,
        usage: {
          storage: {
            used: user.storage_used_bytes || 0,
            usedFormatted: formatBytes(user.storage_used_bytes || 0),
            limit: tierInfo.limits.storage
          }
        }
      }
    });

  } catch (error) {
    console.error('Error fetching subscription:', error);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

/**
 * Get usage statistics
 * GET /api/subscriptions/usage
 */
router.get('/usage', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get user info
    const userResult = await pool.query(
      'SELECT subscription_tier, storage_used_bytes FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const tierInfo = getTierFeatures(user.subscription_tier || 'basic');

    // Get device count
    const deviceResult = await pool.query(
      'SELECT COUNT(*) as count FROM displays WHERE user_id = $1 OR owner_user_id = $1',
      [userId]
    );

    // Get schedule count
    const scheduleResult = await pool.query(
      'SELECT COUNT(*) as count FROM schedules WHERE user_id = $1',
      [userId]
    );

    // Get shared device count (if Pro+)
    let sharedDeviceCount = 0;
    if (user.subscription_tier === 'pro' || user.subscription_tier === 'enterprise') {
      const sharedResult = await pool.query(
        'SELECT COUNT(DISTINCT device_id) as count FROM device_permissions WHERE user_id = $1',
        [userId]
      );
      sharedDeviceCount = parseInt(sharedResult.rows[0].count) || 0;
    }

    // Get playlist count (if Pro+)
    let playlistCount = 0;
    if (user.subscription_tier === 'pro' || user.subscription_tier === 'enterprise') {
      const playlistResult = await pool.query(
        'SELECT COUNT(*) as count FROM playlists WHERE user_id = $1',
        [userId]
      );
      playlistCount = parseInt(playlistResult.rows[0].count) || 0;
    }

    res.json({
      success: true,
      usage: {
        tier: user.subscription_tier || 'basic',
        storage: {
          used: user.storage_used_bytes || 0,
          usedFormatted: formatBytes(user.storage_used_bytes || 0),
          limit: tierInfo.limits.storage,
          percentage: Math.round(((user.storage_used_bytes || 0) / parseFloat(tierInfo.limits.storage)) * 100)
        },
        devices: {
          owned: parseInt(deviceResult.rows[0].count) || 0,
          shared: sharedDeviceCount
        },
        schedules: parseInt(scheduleResult.rows[0].count) || 0,
        playlists: playlistCount
      }
    });

  } catch (error) {
    console.error('Error fetching usage:', error);
    res.status(500).json({ error: 'Failed to fetch usage statistics' });
  }
});

/**
 * Upgrade subscription tier
 * POST /api/subscriptions/upgrade
 * NOTE: This is a placeholder - real implementation would integrate with Stripe
 */
router.post('/upgrade', authenticateToken, async (req, res) => {
  try {
    const { tier } = req.body;
    const userId = req.user.userId;

    const validTiers = ['basic', 'pro', 'enterprise'];
    if (!validTiers.includes(tier)) {
      return res.status(400).json({ error: 'Invalid tier' });
    }

    // Get current tier
    const userResult = await pool.query(
      'SELECT subscription_tier FROM users WHERE id = $1',
      [userId]
    );

    const currentTier = userResult.rows[0].subscription_tier || 'basic';
    const tierLevels = { basic: 1, pro: 2, enterprise: 3 };

    if (tierLevels[tier] <= tierLevels[currentTier]) {
      return res.status(400).json({
        error: 'Can only upgrade to a higher tier. Use downgrade for lower tiers.'
      });
    }

    // Update user tier
    await pool.query(`
      UPDATE users
      SET subscription_tier = $1,
          subscription_status = 'active',
          subscription_started_at = COALESCE(subscription_started_at, NOW()),
          subscription_renews_at = NOW() + INTERVAL '30 days'
      WHERE id = $2
    `, [tier, userId]);

    // Create subscription record
    await pool.query(`
      INSERT INTO subscriptions (
        user_id, tier, status, started_at, renews_at
      ) VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '30 days')
    `, [userId, tier]);

    console.log(`✅ User ${userId} upgraded to ${tier}`);

    res.json({
      success: true,
      message: `Successfully upgraded to ${tier} tier`,
      subscription: {
        tier,
        status: 'active',
        renewsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });

  } catch (error) {
    console.error('Error upgrading subscription:', error);
    res.status(500).json({ error: 'Failed to upgrade subscription' });
  }
});

/**
 * Cancel subscription
 * POST /api/subscriptions/cancel
 */
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Set subscription to cancel at end of billing period
    await pool.query(`
      UPDATE users
      SET subscription_status = 'cancelled'
      WHERE id = $1
    `, [userId]);

    // Update subscription record
    await pool.query(`
      UPDATE subscriptions
      SET status = 'cancelled', cancelled_at = NOW()
      WHERE user_id = $1 AND status = 'active'
    `, [userId]);

    console.log(`📅 User ${userId} cancelled subscription`);

    res.json({
      success: true,
      message: 'Subscription will be cancelled at the end of the billing period'
    });

  } catch (error) {
    console.error('Error cancelling subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

/**
 * Get upgrade options for current user
 * GET /api/subscriptions/upgrade-options
 */
router.get('/upgrade-options', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const userResult = await pool.query(
      'SELECT subscription_tier FROM users WHERE id = $1',
      [userId]
    );

    const currentTier = userResult.rows[0].subscription_tier || 'basic';
    const allTiers = ['basic', 'pro', 'enterprise'];
    const tierLevels = { basic: 1, pro: 2, enterprise: 3 };
    const currentLevel = tierLevels[currentTier];

    const upgradeOptions = allTiers
      .filter(tier => tierLevels[tier] > currentLevel)
      .map(tier => ({
        tier,
        ...getTierFeatures(tier),
        price: tier === 'pro' ? 19 : 99
      }));

    res.json({
      success: true,
      currentTier,
      upgradeOptions
    });

  } catch (error) {
    console.error('Error fetching upgrade options:', error);
    res.status(500).json({ error: 'Failed to fetch upgrade options' });
  }
});

module.exports = router;
