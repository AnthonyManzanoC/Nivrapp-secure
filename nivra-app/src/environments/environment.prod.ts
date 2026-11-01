export const environment = {
  production: true,
  // Keep the current application license. The AGPL prototype is test-only.
  ratchetLaboratory: false,
  ratchetEnabled: true,
  apiBaseUrl: 'https://nivrapp-secure-eaqi.onrender.com',
  // Prefer the healthy shared cluster; the other same-cluster APIs remain failover candidates.
  apiEndpoints: [
    'https://nivrapp-secure-eaqi.onrender.com',
    'https://nivrapp-secure.onrender.com',
    'https://nivra-webapp-secure.onrender.com',
  ],
  apiClusterFingerprint: 'c761492c31e3e9346640c94da63c476eea907d2aad8a26b6d830c60cd5d7fc64',
  firebase: {
    apiKey: 'AIzaSyC4TZyBBy6Hj_2vgAngbuN8QD6ND48GEyg',
    authDomain: 'nivra-af67e.firebaseapp.com',
    projectId: 'nivra-af67e',
    storageBucket: 'nivra-af67e.firebasestorage.app',
    messagingSenderId: '1052459577646',
    appId: '1:1052459577646:web:104a77188d9e03b0b10abf',
    vapidKey: 'BI-QXrOQJ14bj9GWZ5_ZniwQ63HxBW1E2n0qOLCe-fHME72yyuXQz2nRdEjSqstpw7IQNOE9U8fx8l9tGrbYHBY'
  },
  firebaseAppCheckSiteKey: '',
  firebaseVapidKey: 'BI-QXrOQJ14bj9GWZ5_ZniwQ63HxBW1E2n0qOLCe-fHME72yyuXQz2nRdEjSqstpw7IQNOE9U8fx8l9tGrbYHBY',
  livekit: {
    url: '',
    token: ''
  }
};
