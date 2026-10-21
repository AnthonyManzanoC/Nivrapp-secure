# Nivra para Windows

El paquete Electron conserva su perfil por usuario de Windows y su canal de actualizaciones. Para compilar y distribuir el instalador, véase [installer/README.md](installer/README.md).

## Icono de la aplicación

Cuenta permite elegir `original`, `emerald` o `ivory`. La preferencia pertenece al usuario de Windows y se conserva en `app.getPath('userData')/launcher-appearance.json`; no depende de la cuenta de Nivra abierta. El cambio actualiza el icono de la ventana y los accesos directos existentes de Nivra en Escritorio e Inicio. No modifica el ejecutable, el instalador, sus hashes, el registro de otras aplicaciones ni otros accesos directos.

Los tres ICO se distribuyen dentro de `icons/`. En el arranque se copia el recurso seleccionado a `userData/launcher-icons/` mediante escritura temporal exclusiva, sincronización y renombrado atómico. Esto proporciona una ruta física que Windows Shell puede leer aunque el recurso original esté dentro de `app.asar`, y mantiene el icono disponible durante las actualizaciones. Al abrir una versión nueva, se restaura la elección y se reaplica a los accesos existentes que haya recreado el instalador.

Solo se inspeccionan `Nivra.lnk` en el Escritorio del usuario y `Nivra/Nivra.lnk` en su menú Inicio. Antes de cambiar el icono se comprueba que el archivo exista, no sea un enlace simbólico y apunte al ejecutable actual sin argumentos. La operación de Shell es `update` y solo aporta `icon` e `iconIndex`; no crea enlaces ausentes ni cambia destino, argumentos o directorio de trabajo.

El puente `nivraLauncherAppearance` expone únicamente `getState()` y `setIcon(id)`. El proceso principal valida el renderer y su frame mediante los controles existentes, rechaza parámetros adicionales y solo acepta los tres identificadores. No acepta rutas, URL ni bytes del renderer. Las preferencias y los recursos se validan antes de usarlos; los errores enviados al frontend no incluyen rutas del perfil.

Windows puede conservar una copia del icono en su caché o en un acceso anclado a la barra de tareas. Esos accesos anclados no se reescriben; puede ser necesario volver a anclar Nivra para que Windows refleje la elección. El icono incrustado en el EXE y el del instalador conservan la marca del paquete.

La implementación utiliza las API oficiales de Electron para [actualizar propiedades de un acceso directo existente](https://www.electronjs.org/docs/latest/api/shell#shellwriteshortcutlinkshortcutpath-operation-options-windows), [cambiar el icono de la ventana](https://www.electronjs.org/docs/latest/api/browser-window#winseticonicon-windows-linux) y [validar el emisor de los mensajes IPC](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages).

Pruebas aisladas:

```powershell
node --test launcher-appearance.test.js renderer-security.test.js update-ipc.test.js
```

Las pruebas usan perfiles temporales y Shell simulado. No cambian los accesos reales del desarrollador ni equivalen a una instalación interactiva o a la comprobación de la caché de iconos en un usuario de Windows real.
