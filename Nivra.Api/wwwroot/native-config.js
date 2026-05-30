// Cambia este valor antes de regenerar APK/EXE cuando publiques el backend.
window.NIVRA_NATIVE_API_BASE_URL = "https://nivra-webapp-secure.onrender.com";

// Opcional: un bridge nativo o Firebase Web puede inyectar aqui el token FCM.
// La app lo registra contra /push-tokens sin exponerlo en codigo fuente.
window.NIVRA_PUSH_TOKEN = window.NIVRA_PUSH_TOKEN || "";

// Config publica de Firebase Web Messaging para PWA. No pongas aqui la clave Admin SDK.
window.NIVRA_FIREBASE_VAPID_KEY = "BI-QXrOQJ14bj9GWZ5_ZniwQ63HxBW1E2nOq0LCe-fHME72yyuXQz2nRdEjSqstpw7IQNOE9U8fx8l9tGrbYHBY";

window.NIVRA_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAEt5JSj2tZuX2BV56sgtFwpW4SHHt9zRQ",
  authDomain: "nivra-af67e.firebaseapp.com",
  projectId: "nivra-af67e",
  storageBucket: "nivra-af67e.firebasestorage.app",
  messagingSenderId: "1052459577646",
  appId: "1:1052459577646:web:104a77188d9e03b0b10abf"
};

// Solo activar si el backend soporta WebPush estandar ademas de FCM HTTP v1.
window.NIVRA_ENABLE_STANDARD_WEB_PUSH = window.NIVRA_ENABLE_STANDARD_WEB_PUSH || false;
