// const API_BASE_URL = 'http://38.76.219.51:3000/api';
// const API_BASE_URL = 'http://123.57.240.125:3000/api';
const API_BASE_URL = 'http://103.236.70.119:63443/api';
const SERVER_BASE_URL = API_BASE_URL.replace(/\/api\/?$/, '');
const TTS_API_BASE_URL = (typeof window !== 'undefined' && window.location.hostname)
  ? (window.location.protocol + '//' + window.location.hostname + ':52492')
  : 'http://103.236.70.119:52492';
