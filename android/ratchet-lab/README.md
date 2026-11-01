# Ensayo Android de Double Ratchet

Módulo opcional y aplicación **separada**: `com.nivra.ratchetlab`, sin permisos de internet ni acceso a datos de `com.nivra.app`. Solo se incluye al pasar `-PnivraRatchetLab=true`. No participa en los instaladores ni en la aplicación publicada.

Usa el artefacto WASM verificado, WebView real, SQLCipher 4.10.0 y una clave de envoltura AES-256-GCM no exportable de Android Keystore. El secreto aleatorio de SQLCipher se conserva envuelto en las preferencias privadas de esta app de ensayo. La reapertura rechaza secretos ausentes/ilegibles; no crea una base o clave de reemplazo. No se afirma protección por hardware en un emulador.

El puente JavaScript solo se expone a recursos locales de una lista cerrada, mediante `WebViewAssetLoader` y HTTPS local. Se bloquean navegación, marcos, acceso a archivos y contenido remoto. El snapshot completo contiene material privado y solo se guarda dentro de SQLCipher. Las transacciones comparan revisiones y confirman antes de devolver el resultado.

La primera instrumentación crea identidades y una sesión, guarda tres mensajes y recibe uno fuera de orden. Se cierra el proceso. Una segunda instrumentación reabre la base y comprueba identidad estable, reintento idéntico, recuperación de recepción pendiente, claves saltadas, respuesta bidireccional y rechazo de un escritor obsoleto y una clave de base incorrecta. También comprueba que el archivo carece de cabecera SQLite sin cifrar y que la clave de envoltura no es exportable.

Construcción, una vez descargado `crypto/ratchet-wasm/pkg/web` desde CI:

```powershell
cd android
.\gradlew.bat -PnivraRatchetLab=true :ratchet-lab:assembleDebug :ratchet-lab:assembleDebugAndroidTest
```

La instrumentación se ejecuta exclusivamente en un emulador de pruebas y con los APK de este módulo. No instalar el paquete de producción para este ensayo. El flujo `ratchet-server.yml` crea un emulador efímero en CI y ejecuta ambas fases. Una compilación correcta no equivale a una prueba aprobada en Android; revisar el resultado del trabajo `android`.

Este módulo verifica componentes. Aún requiere integración con Capacitor, el gestor de claves y la cola/historial de la app real, migración autenticada de identidades, multidispositivo, retención y revisión independiente. Conserva los límites y las limitaciones de snapshots del laboratorio web.
