// POS Integration Framework
// Supports: Toast, Square, Clover POS systems
const axios = require('axios');
const db = require('./database');

// ========== BASE POS PROVIDER CLASS ==========

class POSProvider {
  constructor(config) {
    this.config = config;
    this.name = 'Base POS Provider';
  }

  async authenticate() {
    throw new Error('authenticate() must be implemented by subclass');
  }

  async getMenu() {
    throw new Error('getMenu() must be implemented by subclass');
  }

  async getCategories() {
    throw new Error('getCategories() must be implemented by subclass');
  }

  async getMenuItems() {
    throw new Error('getMenuItems() must be implemented by subclass');
  }

  async updateMenuItem(itemId, data) {
    throw new Error('updateMenuItem() must be implemented by subclass');
  }
}

// ========== TOAST POS PROVIDER ==========

class ToastPOSProvider extends POSProvider {
  constructor(config) {
    super(config);
    this.name = 'Toast POS';
    this.baseURL = 'https://api.toasttab.com';
    this.apiKey = config.apiKey;
    this.restaurantGuid = config.restaurantGuid;
  }

  async authenticate() {
    try {
      // Toast uses API key authentication
      const response = await axios.get(`${this.baseURL}/restaurants/v1/restaurants/${this.restaurantGuid}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Toast-Restaurant-External-ID': this.restaurantGuid
        }
      });

      console.log('✅ Toast POS authenticated');
      return { success: true, data: response.data };
    } catch (error) {
      console.error('❌ Toast POS authentication failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getMenu() {
    try {
      const response = await axios.get(
        `${this.baseURL}/menus/v2/menus`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Toast-Restaurant-External-ID': this.restaurantGuid
          }
        }
      );

      return { success: true, data: response.data };
    } catch (error) {
      console.error('❌ Failed to get Toast menu:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getMenuItems() {
    try {
      const response = await axios.get(
        `${this.baseURL}/menus/v2/items`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Toast-Restaurant-External-ID': this.restaurantGuid
          }
        }
      );

      return { success: true, data: response.data };
    } catch (error) {
      console.error('❌ Failed to get Toast menu items:', error.message);
      return { success: false, error: error.message };
    }
  }
}

// ========== SQUARE POS PROVIDER ==========

class SquarePOSProvider extends POSProvider {
  constructor(config) {
    super(config);
    this.name = 'Square POS';
    this.baseURL = config.sandbox ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
    this.accessToken = config.accessToken;
    this.locationId = config.locationId;
  }

  async authenticate() {
    try {
      const response = await axios.get(`${this.baseURL}/v2/locations/${this.locationId}`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      console.log('✅ Square POS authenticated');
      return { success: true, data: response.data };
    } catch (error) {
      console.error('❌ Square POS authentication failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getMenu() {
    try {
      const response = await axios.post(
        `${this.baseURL}/v2/catalog/list`,
        {
          types: ['CATEGORY', 'ITEM']
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return { success: true, data: response.data };
    } catch (error) {
      console.error('❌ Failed to get Square catalog:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getMenuItems() {
    try {
      const response = await axios.post(
        `${this.baseURL}/v2/catalog/search`,
        {
          object_types: ['ITEM'],
          limit: 100
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return { success: true, data: response.data };
    } catch (error) {
      console.error('❌ Failed to get Square menu items:', error.message);
      return { success: false, error: error.message };
    }
  }
}

// ========== CLOVER POS PROVIDER ==========

class CloverPOSProvider extends POSProvider {
  constructor(config) {
    super(config);
    this.name = 'Clover POS';
    this.baseURL = config.sandbox ? 'https://sandbox.dev.clover.com' : 'https://api.clover.com';
    this.accessToken = config.accessToken;
    this.merchantId = config.merchantId;
  }

  async authenticate() {
    try {
      const response = await axios.get(
        `${this.baseURL}/v3/merchants/${this.merchantId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`
          }
        }
      );

      console.log('✅ Clover POS authenticated');
      return { success: true, data: response.data };
    } catch (error) {
      console.error('❌ Clover POS authentication failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getMenu() {
    try {
      const response = await axios.get(
        `${this.baseURL}/v3/merchants/${this.merchantId}/categories`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`
          }
        }
      );

      return { success: true, data: response.data };
    } catch (error) {
      console.error('❌ Failed to get Clover menu:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getMenuItems() {
    try {
      const response = await axios.get(
        `${this.baseURL}/v3/merchants/${this.merchantId}/items?expand=categories`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`
          }
        }
      );

      return { success: true, data: response.data };
    } catch (error) {
      console.error('❌ Failed to get Clover menu items:', error.message);
      return { success: false, error: error.message };
    }
  }
}

// ========== POS INTEGRATION MANAGER ==========

class POSIntegrationManager {
  constructor() {
    this.providers = new Map();
  }

  // Register a POS provider for a user
  async registerProvider(userId, providerType, config) {
    try {
      let provider;

      switch (providerType.toLowerCase()) {
        case 'toast':
          provider = new ToastPOSProvider(config);
          break;
        case 'square':
          provider = new SquarePOSProvider(config);
          break;
        case 'clover':
          provider = new CloverPOSProvider(config);
          break;
        default:
          return { success: false, error: 'Unknown POS provider' };
      }

      // Test authentication
      const authResult = await provider.authenticate();
      if (!authResult.success) {
        return { success: false, error: 'Authentication failed' };
      }

      // Save to database
      await db.query(
        `INSERT INTO pos_integrations (user_id, provider_type, config, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET provider_type = $2, config = $3, updated_at = NOW()`,
        [userId, providerType, JSON.stringify(config)]
      );

      // Store in memory
      this.providers.set(userId, provider);

      console.log(`✅ Registered ${providerType} POS for user ${userId}`);
      return { success: true, provider: providerType };
    } catch (error) {
      console.error('❌ Failed to register POS provider:', error);
      return { success: false, error: error.message };
    }
  }

  // Get provider for a user
  async getProvider(userId) {
    // Check memory cache first
    if (this.providers.has(userId)) {
      return this.providers.get(userId);
    }

    // Load from database
    try {
      const result = await db.query(
        'SELECT provider_type, config FROM pos_integrations WHERE user_id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const { provider_type, config } = result.rows[0];
      let provider;

      switch (provider_type.toLowerCase()) {
        case 'toast':
          provider = new ToastPOSProvider(JSON.parse(config));
          break;
        case 'square':
          provider = new SquarePOSProvider(JSON.parse(config));
          break;
        case 'clover':
          provider = new CloverPOSProvider(JSON.parse(config));
          break;
        default:
          return null;
      }

      this.providers.set(userId, provider);
      return provider;
    } catch (error) {
      console.error('❌ Failed to load POS provider:', error);
      return null;
    }
  }

  // Sync menu from POS to SmartStick
  async syncMenu(userId) {
    try {
      const provider = await this.getProvider(userId);

      if (!provider) {
        return { success: false, error: 'No POS provider configured' };
      }

      console.log(`🔄 Syncing menu from ${provider.name}...`);

      const menuResult = await provider.getMenuItems();

      if (!menuResult.success) {
        return { success: false, error: menuResult.error };
      }

      // Process and save menu items
      const items = menuResult.data;
      let syncedCount = 0;

      for (const item of items.elements || items.objects || items) {
        // Extract item data (varies by POS provider)
        const itemData = {
          userId,
          externalId: item.guid || item.id,
          name: item.name,
          description: item.description,
          price: item.price || item.price_money?.amount,
          category: item.category?.name || 'Uncategorized',
          imageUrl: item.image_url || item.image?.url
        };

        // Save to database
        await db.query(
          `INSERT INTO pos_menu_items (user_id, external_id, name, description, price, category, image_url, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (user_id, external_id)
           DO UPDATE SET name = $3, description = $4, price = $5, category = $6, image_url = $7, synced_at = NOW()`,
          [itemData.userId, itemData.externalId, itemData.name, itemData.description, itemData.price, itemData.category, itemData.imageUrl]
        );

        syncedCount++;
      }

      console.log(`✅ Synced ${syncedCount} items from ${provider.name}`);
      return { success: true, syncedCount };
    } catch (error) {
      console.error('❌ Menu sync failed:', error);
      return { success: false, error: error.message };
    }
  }
}

// Export singleton instance
const posManager = new POSIntegrationManager();

module.exports = {
  POSProvider,
  ToastPOSProvider,
  SquarePOSProvider,
  CloverPOSProvider,
  POSIntegrationManager,
  posManager
};
