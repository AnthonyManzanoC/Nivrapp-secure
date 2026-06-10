/// <reference types="@capacitor-firebase/messaging" />
/// <reference types="@capacitor-firebase/authentication" />

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.nivra.app',
  appName: 'Nivra',
  webDir: 'dist/nivra-app/browser',
  backgroundColor: '#070b0d',
  android: {
    backgroundColor: '#070b0d',
  },
  ios: {
    backgroundColor: '#070b0d',
    contentInset: 'never',
  },
  plugins: {
    StatusBar: {
      overlaysWebView: false,
      style: 'DARK',
      backgroundColor: '#070b0d',
    },
    Keyboard: {
      resize: 'body',
      style: 'DEFAULT',
      resizeOnFullScreen: true,
    },
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: true,
      iosKeychainPrefix: 'nivra',
      iosBiometric: {
        biometricAuth: false,
        biometricTitle: 'Nivra',
      },
      androidIsEncryption: true,
      androidBiometric: {
        biometricAuth: false,
        biometricTitle: 'Nivra',
        biometricSubTitle: 'Desbloquear boveda local',
      },
    },
    FirebaseMessaging: {
      presentationOptions: [],
    },
    FirebaseAuthentication: {
      authDomain: undefined,
      skipNativeAuth: false,
      providers: ['phone'],
    },
  },
};

export default config;
