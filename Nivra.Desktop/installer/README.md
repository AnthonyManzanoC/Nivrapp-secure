# Instalador de Windows

El instalador incluye el paquete Electron completo; `Nivra.exe` suelto no es una descarga funcional. El directorio de instalación por usuario es `%LOCALAPPDATA%\Programs\Nivra`, con accesos directos en Escritorio e Inicio y registro de desinstalación. Instalar o actualizar no elimina el perfil ni las claves de Electron en `%APPDATA%\nivra-desktop`. La desinstalación elimina únicamente los archivos del paquete y conserva el perfil.

Requiere Windows 10/11 x64 y NSIS. El script busca `makensis.exe` en PATH, en las instalaciones habituales de NSIS y en la caché local de electron-builder. También acepta `-MakensisPath`. No agrega dependencias npm. La sintaxis y las instrucciones están documentadas en [NSIS](https://nsis.sourceforge.io/Docs/Chapter4.html).

Desde la raíz del repositorio, construir primero el frontend final y después el paquete e instalador:

```powershell
npm --prefix nivra-app run build
npm --prefix Nivra.Desktop run build-exe
npm --prefix Nivra.Desktop run build-installer
```

Salida: `artifacts/Nivra-<versión>-Setup.exe`. El script verifica que el paquete contenga el runtime y el frontend y que la versión del ejecutable coincida con `Nivra.Desktop/package.json`. Puede usarse `-ValidateOnly` para comprobar esos requisitos sin compilar.

La publicación también puede ofrecer un ZIP portable que contenga **todo** `Nivra.Desktop/dist/Nivra-win32-x64`. Ambos formatos deben generarse después del mismo build del frontend. El instalador no está firmado digitalmente; antes de distribuirlo como editor verificado se necesita un certificado de firma de código.

Para comprobar el instalador, usar un usuario o VM de prueba y verificar instalación, acceso directo, bienvenida, actualización y desinstalación. No ejecutar una prueba de instalación/desinstalación contra el perfil del desarrollador. La compilación del instalador no lo ejecuta ni abre la aplicación.
