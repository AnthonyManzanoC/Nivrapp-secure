// This file can be replaced during build by using the `fileReplacements` array.
// `ng build` replaces `environment.ts` with `environment.prod.ts`.
// The list of file replacements can be found in `angular.json`.

export const environment = {
  production: false,
  apiBaseUrl: 'http://localhost:5055',
  firebase: {
    apiKey: 'AIzaSyC4TZyBBy6Hj_2vgAngbuN8QD6ND48GEyg',
    authDomain: 'nivra-af67e.firebaseapp.com',
    projectId: 'nivra-af67e',
    storageBucket: 'nivra-af67e.firebasestorage.app',
    messagingSenderId: '1052459577646',
    appId: '1:1052459577646:web:104a77188d9e03b0b10abf',
    vapidKey: 'BI-QXrOQJ14bj9GWZ5_ZniwQ63HxBW1E2n0qOLCe-fHME72yyuXQz2nRdEjSqstpw7IQNOE9U8fx8l9tGrbYHBY'
  },
  firebaseVapidKey: 'BI-QXrOQJ14bj9GWZ5_ZniwQ63HxBW1E2n0qOLCe-fHME72yyuXQz2nRdEjSqstpw7IQNOE9U8fx8l9tGrbYHBY',
  livekit: {
    url: '',
    token: ''
  }
};

/*
 * For easier debugging in development mode, you can import the following file
 * to ignore zone related error stack frames such as `zone.run`, `zoneDelegate.invokeTask`.
 *
 * This import should be commented out in production mode because it will have a negative impact
 * on performance if an error is thrown.
 */
// import 'zone.js/plugins/zone-error';  // Included with Angular CLI.
