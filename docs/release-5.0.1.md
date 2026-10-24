# Nivra 5.0.1

Cliente **5.0.1**, Android `com.nivra.app`, **versionCode 33**. Compatible con la API **5.0.0** ya desplegada; no necesita nuevos endpoints. El diseño aprobado y el protocolo de llamadas 2 se conservan.

## Recuperación del historial Android anterior

El error `LEGACY_UNENCRYPTED_HISTORY` identificaba una base SQLite de una instalación anterior que el cliente intentaba abrir como SQLCipher. Esta versión añade una migración nativa para esa base fija y privada. Utiliza exclusivamente la contraseña SQLCipher ya conservada, cierra las conexiones y comprueba el esquema antes de convertir los datos.

La migración prepara una copia privada verificada y exporta a un archivo cifrado temporal. Compara esquema, tablas, valores tipados, integridad y versiones antes de reemplazar atómicamente el archivo original. Vuelve a abrir y verificar el resultado antes de retirar la copia temporal en texto plano. Las claves internas del historial también forman parte de la comparación. Los errores conservan la base y sus copias disponibles; no se crea un historial vacío para aparentar una recuperación. Una interrupción posterior a la publicación se valida antes de admitir nuevas escrituras y nunca restaura automáticamente una instantánea anterior.

Esta migración requiere el secreto retenido, espacio suficiente y una base compatible e íntegra. No reconstruye claves perdidas ni datos borrados. Su ejecución con SQLCipher en Android no se ha comprobado en un emulador ni en el teléfono afectado en esta entrega.

## Solicitudes de historial y sincronización

Una solicitud de historial exige un mensaje cifrado válido destinado a la cuenta actual y una identidad propia ya guardada y legible. Una cuenta nueva, un chat vacío, un mensaje de sistema, un sobre ajeno, malformado o vencido no activan esa solicitud. Un almacén de claves local bloqueado o ilegible mantiene su diagnóstico local; no se interpreta como una falta de autorización de otro equipo.

Los recorridos de solicitud, aprobación e importación leen identidades existentes sin generar ni publicar sustitutos. El dispositivo que conserva las claves puede aprobar la vinculación tras comparar el código, tanto si la cuenta comenzó en Android como en web. La plataforma por sí sola no acredita la propiedad del historial.

Los mensajes que se pueden abrir con la clave local actual no esperan la lectura del índice de claves históricas. La recuperación de sobres antiguos exige que los registros propios de ese índice se puedan leer. El cursor HTTP mantiene además un avance en memoria cuando su persistencia local falla temporalmente, para que un fallo de disco no se comunique como una pérdida de conexión.

La actualización automática al reconectar o volver a primer plano mantiene visibles los chats existentes. Las siluetas se reservan para la carga inicial sin datos y para una actualización manual explícita.

## Historias en Android

Al arrastrar hacia abajo desde el inicio de la lista, o regresar al inicio tras desplazarse, se despliegan las historias. Ese gesto no ejecuta una actualización manual. Se descartan gestos horizontales, opciones de fila abiertas, varios dedos y gestos cancelados. La web conserva su gesto y control existentes; no se cambian estilos ni disposición.

## Validación y límites

La suite completa Angular pasó **814/814**, Node **12/12**, las pruebas JVM Android **41/41** y las comprobaciones offline del canal de actualización **20/20**. El APK de pruebas instrumentadas compiló con doce casos de migración, pero esos doce casos **no se ejecutaron**. El usuario solicitó entregar sin emulador después de que la falta de espacio impidiera iniciarlo.

Un ajuste defensivo posterior evita desplegar historias si Ionic reclama el deslizamiento horizontal durante el gesto. La suite final de chats pasó **33/33** tras ese cambio. La compilación web de producción terminó correctamente; conserva un aviso de presupuesto del paquete inicial (3,09 MB frente al objetivo de 2 MB, por debajo del límite de error de 5 MB). El APK final identifica versión 5.0.1/build 33 y se comprobó su firma con el certificado anterior.

APK, instalador Windows y ZIP portátil compilados y verificados. El verificador comparó **1430 archivos web de Windows**, **1429 del APK** (Android omite `.well-known`) y **1430 del ZIP** con la compilación de producción y generó los hashes y metadatos a partir de los binarios finales. El APK mantiene el certificado SHA256 `e455850144d66bc3f96b024ad15b6ed72baab3259424debf428651492fb78e60`. Windows se compiló con la opción `-LowDiskUsage` del instalador, que utiliza compresión por archivo y conserva el contenido instalado.

No se ha realizado una instalación física ni una sincronización real teléfono–web con esta versión. La validación disponible comprueba lógica, compilación, firma y consistencia de los paquetes; no confirma todavía el resultado de la migración en la instalación afectada.
