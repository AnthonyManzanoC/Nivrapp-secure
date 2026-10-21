# Nivra 4.1.0

Esta versión mejora el acceso, la navegación y el control de dispositivos, e incorpora un canal permanente de actualizaciones para Android y Windows. Android versionCode 28; protocolo de llamadas 2, compatible con 4.0.x.

## Experiencia

- Acceso con superficies claras, verde suave y jerarquía más legible; conserva ID/alias, QR, recuperación y los flujos existentes. Añade aviso de Bloq Mayús, oculta la contraseña al cambiar de método o minimizar y evita envíos duplicados.
- Bienvenida exclusiva de aplicaciones, con idioma, progreso y recuperación de errores de navegación. La portada de la web permanece independiente.
- Nuevo chat visible, etiquetas en la navegación móvil y menú accesible por conversación para fijar, silenciar y archivar. Las acciones muestran resultado y no se duplican mientras se guardan.
- Cuenta muestra accesos directos a bloqueo, privacidad y dispositivos. La revocación identifica el equipo, pide confirmación y explica el cierre de sesión y la solicitud de borrado local. Vuelve a comprobar la cuenta y el dispositivo antes de enviar la acción.
- Ajustes visuales compatibles con los temas claro/oscuro y con reducción de movimiento. Veinte textos nuevos completos en los diez idiomas.

## Actualizaciones de las aplicaciones

Instala 4.1.0 una vez para disponer del nuevo canal en ambos sistemas. Windows 4.0.1 no tenía este actualizador y debe recibir esta primera actualización mediante el nuevo instalador.

Android y Windows consultan `https://nivrapp-secure.vercel.app/updates/latest.json` al abrir, al volver al primer plano y cada seis horas de uso. Cuenta permite una comprobación manual. Los fallos de red se presentan como fallos de comprobación y permiten reintentar; no se confunden con estar al día.

La descarga y la instalación requieren acciones separadas del usuario. El aviso y la instalación esperan mientras la aplicación está bloqueada, hay una llamada o se están sincronizando claves/historial o subiendo archivos. Se puede posponer una versión; una versión posterior vuelve a avisar.

Android verifica URL, redirecciones HTTPS permitidas, tamaño y SHA256; antes de instalar también comprueba paquete, versión incremental y el mismo certificado de firma que la app instalada. Windows mantiene el manifiesto y la ruta del instalador en el proceso principal, verifica tamaño/SHA256, guarda de forma atómica y vuelve a verificar antes de ejecutar NSIS. El renderer no puede aportar una URL, hash, ruta o argumento de instalación. Los equipos Windows se actualizan en la misma carpeta por usuario y conservan su perfil y claves locales.

El canal de descubrimiento funciona sin iniciar sesión y no depende del despliegue ni de la disponibilidad de Render. Una función de Vercel obtiene y valida el manifiesto publicado y devuelve JSON con CORS, sin redirigir el cliente. Las rutas de descarga aceptan versiones futuras con el mismo formato. La publicación exige todos los binarios y el manifiesto verificados antes de hacer pública una versión. Véase [el procedimiento permanente](release-update-feed.md).

El instalador Windows conserva la distribución sin firma Authenticode: la verificación usa el origen HTTPS de confianza y el hash del manifiesto, sin una firma de editor independiente. Las garantías y limitaciones criptográficas de las conversaciones no cambian.

## Seguridad y validación

Una sesión cuyo refresh se rechaza definitivamente ya no puede enviar el cuerpo de la petición pendiente ni iniciar un segundo refresh. Un error HTTP redirigido fuera del pool de API verificado no puede ordenar un borrado de dispositivo o una actualización obligatoria.

Compilación de producción, 97 pruebas Angular de producto y 36 de interceptores/pool, 21 pruebas de Android, 28 comprobaciones de Desktop, 6 del proxy de actualizaciones, 20 del contrato de publicación y 12 de metadata de Android. El verificador coteja 1424 recursos web de Windows y del ZIP, y 1423 del APK, con la compilación final y genera hashes y manifiesto después de verificar los paquetes.

Revisión visual de acceso en escritorio/móvil y árabe RTL; Cuenta y confirmación de dispositivos mediante el bundle real con datos ficticios y conexiones limitadas a una API local. El flujo visual de actualización Windows se probó con un bridge simulado, sin descargar ni ejecutar instaladores. No se realizó instalación en un teléfono físico ni una instalación interactiva Windows. La prueba adicional de red ejecutando Electron fue rechazada por la revisión automática con «blocked by policy», sin más motivo disponible; las verificaciones de red en producción y las pruebas aisladas cubren el canal y los controles de descarga.

El bundle inicial conserva el aviso de presupuesto anterior: 3,02 MB frente al umbral de advertencia de 2 MB; el límite de error no se amplió.
