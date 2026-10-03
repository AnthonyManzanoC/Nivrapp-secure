# Remitente sellado: límites y condiciones de activación

Esta entrega NO activa envíos anónimos en el Hub existente. Sus permisos, bloqueos y límites dependen del usuario autenticado. Quitar esa identidad sin reemplazar esas garantías abre una vía de abuso y rompe el modelo de entrega actual.

Un JWT, HMAC o firma normal emitido después del login no constituye un token ciego: el emisor conoce el token y puede vincularlo a su cuenta. Desconectar y reconectar SignalR tampoco elimina IP, tiempo, tamaño ni correlación de conexiones.

El protocolo de admisión propuesto requiere una implementación mantenida de firmas ciegas, por ejemplo una suite concreta de RFC 9474, con pruebas de sus vectores oficiales. Flujo:

1. El cliente genera un nonce aleatorio y ciega el mensaje de autorización con la llave pública común de la época del emisor. El servidor limita la emisión por cuenta y firma el mensaje cegado; no debe elegir una llave distinta por usuario.
2. El cliente finaliza y verifica la firma. Se usan lotes y se separa el momento de emisión del envío para reducir correlación temporal. Esto no garantiza anonimato de red.
3. Un endpoint de entrega separado del Hub autenticado acepta un sobre opaco, destino y prueba de admisión. No lleva bearer, cookies ni identificadores de la sesión anterior. Se valida tamaño, llave/época, firma, expiración y nonce no utilizado.
4. El consumo del nonce y la persistencia del sobre deben ser una transacción atómica, con índice único, cuotas de tamaño y protección contra reenvío. La validación en el handshake del WebSocket no basta: se requiere validación por mensaje.
5. El receptor valida la identidad y autenticidad dentro del sobre E2EE. Los permisos de recepción y bloqueo deben usar capacidades de entrega independientes, sin revelar al servidor el remitente. Los acuses también necesitan un diseño que no lo revele.

Antes de activar: biblioteca y suite seleccionadas, formato versionado, revisión de autenticidad del sobre, control de abuso, pruebas concurrentes/replay/rotación, revisión externa y política de logs. El servidor seguirá conociendo el destino y puede observar la IP de quien se conecta; no se puede prometer ausencia de metadatos.

Referencias: [RFC 9474](https://www.rfc-editor.org/rfc/rfc9474.html), [diseño de Sealed Sender de Signal](https://signal.org/blog/sealed-sender/).
