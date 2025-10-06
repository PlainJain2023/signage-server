const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const SERVER_URL = 'http://localhost:5000';
const TEST_PASSWORD = 'signage-secure-2025';

console.log('🧪 Testing Password Authentication\n');
console.log('=' .repeat(50));

// Create a tiny test image buffer (1x1 pixel PNG)
const testImageBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

async function testWithPassword() {
  console.log('\n✅ Test 1: Upload WITH correct password');
  console.log('-'.repeat(50));
  
  try {
    const formData = new FormData();
    formData.append('image', testImageBuffer, {
      filename: 'test.png',
      contentType: 'image/png'
    });

    const response = await axios.post(`${SERVER_URL}/api/upload`, formData, {
      headers: {
        ...formData.getHeaders(),
        'x-admin-password': TEST_PASSWORD
      }
    });

    console.log('✅ SUCCESS: Upload completed');
    console.log('📊 Response:', response.data);
    console.log('🔐 Server should log: "Authenticated: true"');
  } catch (error) {
    console.log('❌ FAILED:', error.message);
  }
}

async function testWithoutPassword() {
  console.log('\n⚠️  Test 2: Upload WITHOUT password');
  console.log('-'.repeat(50));
  
  try {
    const formData = new FormData();
    formData.append('image', testImageBuffer, {
      filename: 'test.png',
      contentType: 'image/png'
    });

    const response = await axios.post(`${SERVER_URL}/api/upload`, formData, {
      headers: formData.getHeaders()
      // No password header
    });

    console.log('⚠️  COMPLETED: Upload went through (expected since we\'re not blocking yet)');
    console.log('📊 Response:', response.data);
    console.log('🔐 Server should log: "Authenticated: false" and warning');
  } catch (error) {
    console.log('❌ Request failed:', error.message);
  }
}

async function testWithWrongPassword() {
  console.log('\n❌ Test 3: Upload with WRONG password');
  console.log('-'.repeat(50));
  
  try {
    const formData = new FormData();
    formData.append('image', testImageBuffer, {
      filename: 'test.png',
      contentType: 'image/png'
    });

    const response = await axios.post(`${SERVER_URL}/api/upload`, formData, {
      headers: {
        ...formData.getHeaders(),
        'x-admin-password': 'wrong-password-123'
      }
    });

    console.log('⚠️  COMPLETED: Upload went through (expected since we\'re not blocking yet)');
    console.log('📊 Response:', response.data);
    console.log('🔐 Server should log: "Authenticated: false" and warning');
  } catch (error) {
    console.log('❌ Request failed:', error.message);
  }
}

async function runTests() {
  console.log('\n🚀 Starting Authentication Tests...\n');
  console.log('📝 Make sure your server is running: npm start\n');
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  try {
    await testWithPassword();
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    await testWithoutPassword();
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    await testWithWrongPassword();
    
    console.log('\n' + '='.repeat(50));
    console.log('\n✅ All tests completed!');
    console.log('\n📋 NEXT STEPS:');
    console.log('1. Check your server console for authentication logs');
    console.log('2. If you see "Authenticated: true" for Test 1, it\'s working!');
    console.log('3. Tests 2 & 3 should show "Authenticated: false" with warnings');
    console.log('4. Once confirmed, we\'ll enforce the password blocking\n');
  } catch (error) {
    console.log('\n❌ Test suite failed:', error.message);
    console.log('\n💡 Make sure the server is running on port 5000');
  }
}

// Run the tests
runTests();
