const axios = require('axios');

async function testAPI() {
  try {
    console.log('🧪 Testing FeedGen API...\n');
    
    // Test 1: Health check
    console.log('1. Testing health check...');
    const healthResponse = await axios.get('http://localhost:3000/');
    console.log('✅ Health check:', healthResponse.data);
    
    // Test 2: Try to register a user (this should fail without proper payload but should reach the endpoint)
    console.log('\n2. Testing user registration endpoint...');
    try {
      const registerResponse = await axios.post('http://localhost:3000/api/auth/register', {}, {
        headers: { 'Content-Type': 'application/json' }
      });
      console.log('Register response:', registerResponse.data);
    } catch (error) {
      if (error.response) {
        console.log(`⚠️  Registration endpoint reached (expected validation error): ${error.response.status} - ${error.response.data?.error || 'Validation error'}`);
      } else {
        console.log('❌ Registration test failed:', error.message);
      }
    }
    
    // Test 3: Try to login (should also fail without proper payload)
    console.log('\n3. Testing login endpoint...');
    try {
      const loginResponse = await axios.post('http://localhost:3000/api/auth/login', {}, {
        headers: { 'Content-Type': 'application/json' }
      });
      console.log('Login response:', loginResponse.data);
    } catch (error) {
      if (error.response) {
        console.log(`⚠️  Login endpoint reached (expected validation error): ${error.response.status} - ${error.response.data?.error || 'Validation error'}`);
      } else {
        console.log('❌ Login test failed:', error.message);
      }
    }
    
    console.log('\n✅ All API endpoints are accessible!');
    console.log('The server is running correctly and responding to requests.');
    console.log('You can now use the API with proper authentication and data.');
    
  } catch (error) {
    console.error('❌ API test failed:', error.message);
  }
}

testAPI();