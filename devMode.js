/**
 * Developer Mode Service
 *
 * Provides developer mode detection and utilities for testing and development.
 * This should ONLY be enabled on local development machines, never in production.
 */

class DevMode {
  constructor() {
    this.isEnabled = process.env.DEV_MODE === 'true';
    this.initialize();
  }

  initialize() {
    if (this.isEnabled) {
      console.log('\n🧪 ═══════════════════════════════════════');
      console.log('🧪 DEVELOPER MODE ENABLED');
      console.log('🧪 ═══════════════════════════════════════');
      console.log('🧪 Features enabled:');
      console.log('   • Auto-bypass email verification');
      console.log('   • Mock data generators');
      console.log('   • Workflow simulators');
      console.log('   • Test user creation');
      console.log('   • Visual dev mode indicators');
      console.log('🧪 ═══════════════════════════════════════\n');
    }
  }

  /**
   * Check if developer mode is enabled
   */
  isDevMode() {
    return this.isEnabled;
  }

  /**
   * Check if email verification should be bypassed
   */
  shouldBypassEmailVerification() {
    return this.isEnabled;
  }

  /**
   * Check if an email is a test email
   */
  isTestEmail(email) {
    if (!email) return false;

    const testDomains = [
      'test.com',
      'example.com',
      'fake.com',
      'mock.com',
      'dev.test',
      'localhost'
    ];

    const testPrefixes = [
      'test',
      'fake',
      'mock',
      'dev',
      'demo'
    ];

    const emailLower = email.toLowerCase();
    const domain = emailLower.split('@')[1];
    const prefix = emailLower.split('@')[0];

    // Check if domain is a test domain
    if (testDomains.includes(domain)) {
      return true;
    }

    // Check if prefix contains test keywords
    if (testPrefixes.some(p => prefix.startsWith(p))) {
      return true;
    }

    return false;
  }

  /**
   * Generate a fake email for testing
   */
  generateFakeEmail() {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000);
    return `test.user.${timestamp}.${random}@test.com`;
  }

  /**
   * Generate a fake user name
   */
  generateFakeName() {
    const firstNames = [
      'Alex', 'Jordan', 'Casey', 'Morgan', 'Taylor',
      'Sam', 'Riley', 'Avery', 'Quinn', 'Skyler'
    ];
    const lastNames = [
      'Smith', 'Johnson', 'Williams', 'Brown', 'Jones',
      'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez'
    ];

    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];

    return `${firstName} ${lastName}`;
  }

  /**
   * Generate a fake device serial number
   */
  generateFakeSerialNumber() {
    const prefix = 'DEV';
    const timestamp = Date.now().toString().slice(-8);
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * Generate a fake pairing code
   */
  generateFakePairingCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude similar characters
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  /**
   * Log dev mode action
   */
  log(message, data = null) {
    if (!this.isEnabled) return;

    console.log(`🧪 [DEV MODE] ${message}`);
    if (data) {
      console.log('🧪 Data:', JSON.stringify(data, null, 2));
    }
  }

  /**
   * Warn if dev mode is accidentally enabled in production
   */
  checkProductionSafety() {
    const isProduction = process.env.NODE_ENV === 'production';
    const hasProductionDb = process.env.DATABASE_URL?.includes('render.com') ||
                           process.env.DATABASE_URL?.includes('heroku') ||
                           process.env.DATABASE_URL?.includes('aws');

    if (this.isEnabled && (isProduction || hasProductionDb)) {
      console.error('\n⚠️  ═══════════════════════════════════════');
      console.error('⚠️  WARNING: DEV MODE ENABLED IN PRODUCTION!');
      console.error('⚠️  ═══════════════════════════════════════');
      console.error('⚠️  This is extremely dangerous!');
      console.error('⚠️  Set DEV_MODE=false in .env immediately!');
      console.error('⚠️  ═══════════════════════════════════════\n');

      // Don't auto-disable to make it more obvious
      // Developers should explicitly fix this
    }
  }
}

// Export singleton instance
module.exports = new DevMode();
