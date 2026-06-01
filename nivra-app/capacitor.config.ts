/// <reference types="@capacitor-firebase/messaging" />

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.nivra.app',
  appName: 'Nivra',
  webDir: 'dist/nivra-app/browser',
  backgroundColor: '#070b0d',
  server: {
    androidScheme: 'https',
    cleartext: false,
  },
  android: {
    backgroundColor: '#070b0d',
  },
  ios: {
    backgroundColor: '#070b0d',
    contentInset: 'never',
  },
  plugins: {
    Keyboard: {
      resize: 'body',
      style: 'DARK',
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
  },
};

export default config;
