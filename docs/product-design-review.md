# Revisión de experiencia de Nivra

## Cambios locales

Acceso: composición con presentación editorial en escritorio, formulario de una columna en móvil, mensajes centrados en el usuario, mejor contraste en la vista de ejemplo y corrección de la etiqueta de contraseña. No se modificaron autenticación, SMS o QR.

Sistema visual: superficies más sobrias, menos sombras y degradados, radios consistentes, encabezados legibles, foco visible y respeto por movimiento reducido. Las reglas se limitan a superficies de producto y no modifican las dimensiones de pistas de video ni los tableros de juegos.

Grupos: centro en Mundo con búsqueda, acceso directo y filtro para grupos donde solo administradores publican. Respeta pertenencia activa y las reglas existentes. No es una comunidad de varios grupos ni un canal público; no cambia permisos de publicación.

Llamadas: nombres accesibles, estado pulsado y ayuda en controles de micrófono y salida de audio. No se modificó transporte WebRTC ni se incorporó CoTURN.

## Verificación y límites

Portada comprobada visualmente en navegador local y viewport móvil de 390 px. Pruebas Angular incluyen pertenencia de grupos, exclusión de miembros retirados y combinación de búsqueda con avisos de administradores. Las pantallas autenticadas aún requieren revisión visual con cuentas de ensayo. La compilación conserva las advertencias de tamaño existentes; no se ampliaron presupuestos.

## Siguiente alcance funcional

Comunidades reales requieren entidad de comunidad, roles propios, vinculación de grupos, reglas de descubrimiento, invitaciones y revocación. Canales públicos necesitan suscripciones, moderación, límites de publicación y una explicación explícita de qué contenido es público. Un grupo de avisos privado ya ofrece comunicación de uno a muchos sin inventar estas garantías.

El progreso hacia un modelo como Signal depende de protocolo, claves, dispositivos, auditorías y metadatos; el acabado visual no aumenta por sí mismo la seguridad criptográfica. Se conserva la verificación de identidad del trabajo anterior y CoTURN sigue archivado en su rama futura. No se desplegaron estos cambios.
