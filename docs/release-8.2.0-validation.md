# Nivra 8.2.0: validación de publicación

Fecha: 2026-11-02. Código funcional verificado: c5884f11de8c740999cd20cf043134ef5f05e886.

- [Verificación completa, siete trabajos correctos](https://github.com/AnthonyManzanoC/Nivrapp-secure/actions/runs/41401524509): Rust y WASM híbrido, 1551 pruebas Angular, compilación web, PostgreSQL/HTTP real, Electron en Windows y Linux, Android WebView/SQLCipher/Keystore con reinicio del proceso y tres pruebas de recepción nativa de llamadas.
- [Revisión visual independiente](https://github.com/AnthonyManzanoC/Nivrapp-secure/actions/runs/41401524483): buscador, menú móvil, botón flotante que se contrae, historias desplazables sin superponer la X, Contactos/solicitudes, Mundo, doce colores del editor, visor, juegos e invitación temporal. Datos sintéticos, sin cuentas reales ni red externa.
- 18 comprobaciones HTTP de autenticación: las rutas antiguas de OTP solo existen en Development. Firebase sigue mapeado en los otros entornos. No se usan bases ni SMS externos.
- 125 comprobaciones del servidor de llamadas, incluida la validación de ICE y el rechazo de configuraciones privadas incompletas.
- Compilación Android de publicación no depurable, paquete com.nivra.app, versión 8.2.0, código 53 y certificado anterior e455850144d66bc3f96b024ad15b6ed72baab3259424debf428651492fb78e60.
- Verificación de 1444 archivos web en escritorio y ZIP y 1443 en APK. La diferencia es el archivo web de asociaciones de enlaces, omitido por Android. Los hashes coinciden con la compilación usada para publicar.
- APK SHA256: 43d89f9eb25daab1d1545d44e2376562fe72c2c206294a447e12b7a0f95f7c51.
- Instalador Windows SHA256: 07faee19b76eb4f88f7ff5b4b625e01934f8370c62d22aba248cb45eadee7320.
- ZIP Windows SHA256: 834affd564232cc4a2dd28afddaf51263896d3d861457f7226c92da25308b8f7.

El código de TURN y Firebase por teléfono se conserva. Su activación sigue aplazada por el propietario. Se oculta únicamente el radar visible; no se eliminan los servicios de teléfono. El ratchet híbrido y los lectores del historial anterior se mantienen.

Las pruebas automatizadas no certifican todas las redes o fabricantes. Quedan las pruebas en teléfonos físicos (bloqueo, ahorro de batería, cambios de red y compartir pantalla) y la auditoría externa del protocolo. La publicación de los clientes requiere desplegar el mismo código de API en Render para las notas propias y la información de versión actualizada.
