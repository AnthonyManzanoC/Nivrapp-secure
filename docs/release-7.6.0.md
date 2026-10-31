# Nivra 7.6.0 — acceso y consultas de sincronización

Android build 48. No requiere migraciones ni cambios de llaves.

- Fijar, silenciar y archivar se abren desde el lado izquierdo de la lista.
- La tarjeta de contacto abre la información incluso cuando el chat ya está cargado. En un chat protegido, espera a que se desbloquee.
- Bienvenida y acceso siguen el tema claro u oscuro del sistema, conservando las preferencias de cada cuenta.
- La API divide las lecturas de colecciones de destinatarios y recibos para evitar su multiplicación en los mensajes sincronizados. La lista de mensajes borrados obtiene solamente sus datos necesarios. Se mantiene el margen existente para mensajes que se confirman con retraso.

La optimización requiere desplegar esta versión de la API; no modifica las cuotas ni levanta una restricción de Supabase ya activa. La captura de uso agregado no identifica qué servicio o consulta produjo el consumo: se necesita revisar el desglose y los registros del proveedor.

La comprobación `dotnet run --project checks/Nivra.DatabaseChecks -- --sql-only` revisa la traducción SQL con Npgsql sin conectarse a ninguna base de datos. Las pruebas contra una base PostgreSQL real y una medición del ahorro de red requieren un entorno disponible.
