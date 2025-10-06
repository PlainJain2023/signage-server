const axios = require('axios');
const FormData = require('form-data');

const SERVER_URL = 'http://localhost:5000';
const TEST_PASSWORD = 'signage-secure-2025';

const testImageBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

async function testNormalUsage() {
  console.log('\n✅ Test 1: Normal Usage (10 uploads in quick succession)');
  console.log('-'.repeat(60));
  
  let successCount = 0;
  for (let i = 1; i <= 10; i++) {
    try {
      const formData = new FormData();
      formData.append('image', testImageBuffer, `test${i}.png`);
      
      await axios.post(`${SERVER_URL}/api/upload`, formData, {
        headers: {
          ...formData.getHeaders(),
          'x-admin-password': TEST_PASSWORD
        }
      });
      successCount++;
      process.stdout.write(`✅ Upload ${i}/10 succeeded `);
    } catch (error) {
      console.log(`\n❌ Upload ${i} failed:`, error.response?.status, error.response?.data);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log(`\n\n📊 Result: ${successCount}/10 uploads succeeded`);
  console.log('✅ All normal uploads should succeed (under 50/minute limit)\n');
}

async function testRateLimit() {
  console.log('\n⚠️  Test 2: Rate Limit (55 rapid uploads - should hit 50/minute limit)');
  console.log('-'.repeat(60));
  
  let successCount = 0;
  let blockedCount = 0;
  
  for (let i = 1; i <= 55; i++) {
    try {
      const formData = new FormData();
      formData.append('image', testImageBuffer, `rapid${i}.png`);
      
      await axios.post(`${SERVER_URL}/api/upload`, formData, {
        headers: {
          ...formData.getHeaders(),
          'x-admin-password': TEST_PASSWORD
        }
      });
      successCount++;
      process.stdout.write('✅ ');
    } catch (error) {
      if (error.response?.status === 429) {
        blockedCount++;
        process.stdout.write('🚫 ');
      } else {
        console.log(`\n❌ Unexpected error:`, error.response?.status, error.response?.data);
      }
    }
    // No delay - rapid fire
  }
  
  console.log(`\n\n📊 Result: ${successCount} succeeded, ${blockedCount} blocked by rate limit`);
  console.log('✅ Expected: ~50 succeeded, ~5 blocked');
  console.log(`🎯 Rate limiter is ${blockedCount > 0 ? 'WORKING' : 'NOT WORKING'}\n`);
}

async function testAPIRateLimit() {
  console.log('\n⚠️  Test 3: API Rate Limit (checking schedules endpoint)');
  console.log('-'.repeat(60));
  
  let successCount = 0;
  let blockedCount = 0;
  
  for (let i = 1; i <= 110; i++) {
    try {
      await axios.get(`${SERVER_URL}/api/schedules`);
      successCount++;
      if (i % 10 === 0) process.stdout.write(`✅ ${i} `);
    } catch (error) {
      if (error.response?.status === 429) {
        blockedCount++;
        process.stdout.write('🚫 ');
      }
    }
  }
  
  console.log(`\n\n📊 Result: ${successCount} succeeded, ${blockedCount} blocked`);
  console.log('✅ Expected: ~100 succeeded, ~10 blocked\n');
}

async function runTests() {
  console.log('\n' + '='.repeat(60));
  console.log('  🛡️  RATE LIMITING TESTS');
  console.log('='.repeat(60));
  console.log('\n📝 Make sure server is running: npm start\n');
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  try {
    // Test 1: Normal usage should work fine
    await testNormalUsage();
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test 2: Rapid uploads should hit rate limit
    await testRateLimit();
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test 3: API rate limit
    await testAPIRateLimit();
    
    console.log('='.repeat(60));
    console.log('\n✅ All rate limiting tests completed!');
    console.log('\n📋 SUMMARY:');
    console.log('- Normal usage (10 uploads): Should all succeed ✅');
    console.log('- Rapid uploads (55 in 1 min): ~50 succeed, ~5 blocked 🚫');
    console.log('- API requests (110 in 1 min): ~100 succeed, ~10 blocked 🚫');
    console.log('\n🎯 Rate limits are GENEROUS but PROTECTIVE:');
    console.log('   • 50 uploads/minute = plenty for normal use');
    console.log('   • 500 uploads/hour = protects against sustained abuse');
    console.log('   • 100 API calls/minute = smooth scheduling operations\n');
    
  } catch (error) {
    console.log('\n❌ Test suite failed:', error.message);
    console.log('💡 Make sure the server is running on port 5000');
  }
}

runTests();
