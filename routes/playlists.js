/**
 * Playlist Routes (Pro Tier Feature)
 * Allows users to create playlists with multiple content items in rotation
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');
const { canCreatePlaylists } = require('../middleware/tierCheck');

// ═══════════════════════════════════════════════════════════
// PLAYLIST ENDPOINTS
// ═══════════════════════════════════════════════════════════

/**
 * Create a new playlist
 * POST /api/playlists
 * Requires: Pro tier or higher
 */
router.post('/', authenticateToken, canCreatePlaylists, async (req, res) => {
  try {
    const { name, description, loopPlaylist = true, items = [] } = req.body;
    const userId = req.user.userId;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Playlist name is required' });
    }

    // Create playlist
    const playlistResult = await pool.query(`
      INSERT INTO playlists (user_id, name, description, loop_playlist)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [userId, name.trim(), description || null, loopPlaylist]);

    const playlist = playlistResult.rows[0];

    // Add items if provided
    if (items.length > 0) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await pool.query(`
          INSERT INTO playlist_items (
            playlist_id, content_url, content_type, duration, order_index
          ) VALUES ($1, $2, $3, $4, $5)
        `, [
          playlist.id,
          item.contentUrl,
          item.contentType || 'image',
          item.duration || 30000,
          i
        ]);
      }
    }

    console.log(`✅ Playlist created: ${name} (${items.length} items)`);

    res.json({
      success: true,
      playlist: {
        id: playlist.id,
        name: playlist.name,
        description: playlist.description,
        loopPlaylist: playlist.loop_playlist,
        itemCount: items.length,
        createdAt: playlist.created_at
      }
    });

  } catch (error) {
    console.error('Error creating playlist:', error);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

/**
 * Get all playlists for current user
 * GET /api/playlists
 */
router.get('/', authenticateToken, canCreatePlaylists, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(`
      SELECT
        p.*,
        COUNT(pi.id) as item_count
      FROM playlists p
      LEFT JOIN playlist_items pi ON p.id = pi.playlist_id
      WHERE p.user_id = $1
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `, [userId]);

    res.json({
      success: true,
      playlists: result.rows.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        loopPlaylist: p.loop_playlist,
        isTemplate: p.is_template,
        itemCount: parseInt(p.item_count) || 0,
        createdAt: p.created_at
      }))
    });

  } catch (error) {
    console.error('Error fetching playlists:', error);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

/**
 * Get specific playlist with all items
 * GET /api/playlists/:id
 */
router.get('/:id', authenticateToken, canCreatePlaylists, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Get playlist
    const playlistResult = await pool.query(
      'SELECT * FROM playlists WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (playlistResult.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const playlist = playlistResult.rows[0];

    // Get items
    const itemsResult = await pool.query(
      'SELECT * FROM playlist_items WHERE playlist_id = $1 ORDER BY order_index ASC',
      [id]
    );

    res.json({
      success: true,
      playlist: {
        id: playlist.id,
        name: playlist.name,
        description: playlist.description,
        loopPlaylist: playlist.loop_playlist,
        isTemplate: playlist.is_template,
        createdAt: playlist.created_at,
        items: itemsResult.rows.map(item => ({
          id: item.id,
          contentUrl: item.content_url,
          contentType: item.content_type,
          duration: item.duration,
          orderIndex: item.order_index
        }))
      }
    });

  } catch (error) {
    console.error('Error fetching playlist:', error);
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
});

/**
 * Update playlist
 * PUT /api/playlists/:id
 */
router.put('/:id', authenticateToken, canCreatePlaylists, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, loopPlaylist } = req.body;
    const userId = req.user.userId;

    // Verify ownership
    const checkResult = await pool.query(
      'SELECT * FROM playlists WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Update playlist
    const result = await pool.query(`
      UPDATE playlists
      SET name = COALESCE($1, name),
          description = COALESCE($2, description),
          loop_playlist = COALESCE($3, loop_playlist)
      WHERE id = $4 AND user_id = $5
      RETURNING *
    `, [name, description, loopPlaylist, id, userId]);

    console.log(`✅ Playlist updated: ${result.rows[0].name}`);

    res.json({
      success: true,
      playlist: {
        id: result.rows[0].id,
        name: result.rows[0].name,
        description: result.rows[0].description,
        loopPlaylist: result.rows[0].loop_playlist
      }
    });

  } catch (error) {
    console.error('Error updating playlist:', error);
    res.status(500).json({ error: 'Failed to update playlist' });
  }
});

/**
 * Delete playlist
 * DELETE /api/playlists/:id
 */
router.delete('/:id', authenticateToken, canCreatePlaylists, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Delete playlist (items will cascade delete)
    const result = await pool.query(
      'DELETE FROM playlists WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    console.log(`🗑️ Playlist deleted: ${result.rows[0].name}`);

    res.json({
      success: true,
      message: 'Playlist deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting playlist:', error);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

/**
 * Add item to playlist
 * POST /api/playlists/:id/items
 */
router.post('/:id/items', authenticateToken, canCreatePlaylists, async (req, res) => {
  try {
    const { id } = req.params;
    const { contentUrl, contentType = 'image', duration = 30000 } = req.body;
    const userId = req.user.userId;

    if (!contentUrl) {
      return res.status(400).json({ error: 'Content URL is required' });
    }

    // Verify playlist ownership
    const playlistResult = await pool.query(
      'SELECT * FROM playlists WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (playlistResult.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Get current max order_index
    const maxOrderResult = await pool.query(
      'SELECT COALESCE(MAX(order_index), -1) as max_order FROM playlist_items WHERE playlist_id = $1',
      [id]
    );

    const nextOrder = maxOrderResult.rows[0].max_order + 1;

    // Add item
    const result = await pool.query(`
      INSERT INTO playlist_items (playlist_id, content_url, content_type, duration, order_index)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [id, contentUrl, contentType, duration, nextOrder]);

    console.log(`✅ Item added to playlist ${id}`);

    res.json({
      success: true,
      item: {
        id: result.rows[0].id,
        contentUrl: result.rows[0].content_url,
        contentType: result.rows[0].content_type,
        duration: result.rows[0].duration,
        orderIndex: result.rows[0].order_index
      }
    });

  } catch (error) {
    console.error('Error adding item to playlist:', error);
    res.status(500).json({ error: 'Failed to add item' });
  }
});

/**
 * Remove item from playlist
 * DELETE /api/playlists/:id/items/:itemId
 */
router.delete('/:id/items/:itemId', authenticateToken, canCreatePlaylists, async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const userId = req.user.userId;

    // Verify playlist ownership
    const playlistResult = await pool.query(
      'SELECT * FROM playlists WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (playlistResult.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Delete item
    const result = await pool.query(
      'DELETE FROM playlist_items WHERE id = $1 AND playlist_id = $2 RETURNING *',
      [itemId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    // Reorder remaining items
    await pool.query(`
      UPDATE playlist_items
      SET order_index = order_index - 1
      WHERE playlist_id = $1 AND order_index > $2
    `, [id, result.rows[0].order_index]);

    console.log(`🗑️ Item removed from playlist ${id}`);

    res.json({
      success: true,
      message: 'Item removed successfully'
    });

  } catch (error) {
    console.error('Error removing item:', error);
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

/**
 * Reorder playlist items
 * PUT /api/playlists/:id/reorder
 */
router.put('/:id/reorder', authenticateToken, canCreatePlaylists, async (req, res) => {
  try {
    const { id } = req.params;
    const { itemIds } = req.body; // Array of item IDs in new order
    const userId = req.user.userId;

    if (!Array.isArray(itemIds)) {
      return res.status(400).json({ error: 'itemIds must be an array' });
    }

    // Verify playlist ownership
    const playlistResult = await pool.query(
      'SELECT * FROM playlists WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (playlistResult.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Update order for each item
    for (let i = 0; i < itemIds.length; i++) {
      await pool.query(
        'UPDATE playlist_items SET order_index = $1 WHERE id = $2 AND playlist_id = $3',
        [i, itemIds[i], id]
      );
    }

    console.log(`✅ Playlist ${id} items reordered`);

    res.json({
      success: true,
      message: 'Playlist reordered successfully'
    });

  } catch (error) {
    console.error('Error reordering playlist:', error);
    res.status(500).json({ error: 'Failed to reorder playlist' });
  }
});

module.exports = router;
