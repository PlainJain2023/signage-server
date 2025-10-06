const axios = require('axios');
const FormData = require('form-data');

const SERVER_URL = 'http://localhost:5000';
const TEST_PASSWORD = 'signage-secure-2025';

const testImageBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

async function verifyEnforcement() {
  console.log('\n🔒 VERIFICATION TEST: Password Enforcement\n');
  console.log('='.repeat(50));

  // Test 1: Correct password - Should SUCCEED
  console.log('\n✅ Test 1: With CORRECT password (should succeed)');
  try {
    const formData1 = new FormData();
    formData1.append('image', testImageBuffer, 'test.png');
    await axios.post(`${SERVER_URL}/api/upload`, formData1, {
      headers: { ...formData1.getHeaders(), 'x-admin-password': TEST_PASSWORD }
    });
    console.log('✅ SUCCESS: Upload completed (expected)');
  } catch (error) {
    console.log('❌ FAILED: This should have worked!', error.response?.data || error.message);
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  // Test 2: No password - Should FAIL
  console.log('\n🚫 Test 2: WITHOUT password (should be blocked)');
  try {
    const formData2 = new FormData();
    formData2.append('image', testImageBuffer, 'test.png');
    await axios.post(`${SERVER_URL}/api/upload`, formData2, {
      headers: formData2.getHeaders()
    });
    console.log('❌ PROBLEM: Upload succeeded when it should have been blocked!');
  } catch (error) {
    if (error.response?.status === 401) {
      console.log('✅ BLOCKED: Correctly rejected (401 Unauthorized)');
      console.log('📝 Error message:', error.response.data.error);
    } else {
      console.log('⚠️  Different error:', error.message);
    }
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  // Test 3: Wrong password - Should FAIL
  console.log('\n🚫 Test 3: With WRONG password (should be blocked)');
  try {
    const formData3 = new FormData();
    formData3.append('image', testImageBuffer, 'test.png');
    await axios.post(`${SERVER_URL}/api/upload`, formData3, {
      headers: { ...formData3.getHeaders(), 'x-admin-password': 'wrong-password' }
    });
    console.log('❌ PROBLEM: Upload succeeded when it should have been blocked!');
  } catch (error) {
    if (error.response?.status === 401) {
      console.log('✅ BLOCKED: Correctly rejected (401 Unauthorized)');
      console.log('📝 Error message:', error.response.data.error);
    } else {
      console.log('⚠️  Different error:', error.message);
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log('\n🎉 Verification complete!');
  console.log('\n📋 SUMMARY:');
  console.log('- Correct password: ✅ Should allow upload');
  console.log('- No password: 🚫 Should block (401)');
  console.log('- Wrong password: 🚫 Should block (401)\n');
}

verifyEnforcement();
