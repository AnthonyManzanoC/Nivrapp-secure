# Recuperar Supabase y desplegar Nivra 4.0.0

El registro de producción identifica `XX000 / EMAXCONNSESSION`: el pool de sesiones de Supabase admite 15 clientes y las APIs intentaban abrir hasta 200 conexiones por proceso. El código anterior también reemplazaba el límite explícito de la cadena de conexión.

La versión 4.0.0 utiliza un máximo predeterminado de **3 conexiones por proceso** cuando el host es el pooler de Supabase y el puerto es 5432. Conserva los límites explícitos, libera conexiones inactivas a los 30 segundos y devuelve `503 store_unavailable` con `Retry-After: 3` ante saturación temporal. Una falla al validar revocación de dispositivo también devuelve 503; se puede reintentar sin cerrar la cuenta ni omitir la validación.

## Configuración y despliegue

1. En ambos servicios de Render, conservar la base, firma, Redis y almacenamiento compartidos. Agregar a la cadena **existente** de `ConnectionStrings__Supabase` estos parámetros, usando las credenciales ya guardadas en Render:

   ```text
   Maximum Pool Size=3;Minimum Pool Size=0;Connection Idle Lifetime=30;Connection Pruning Interval=5;Include Error Detail=false;
   ```

2. Hacer **Manual Deploy del commit de 4.0.0** en las APIs disponibles. El servidor y los clientes deben actualizarse: instalar solo el APK o EXE no cambia el pool del servidor. Esta versión conserva el puerto 5432 y la huella del cluster; no agrega migraciones.
3. Si el proceso antiguo sigue ocupando los 15 slots y el nuevo despliegue no puede arrancar, retirar/reiniciar los procesos antiguos desde Render para liberar sus conexiones antes de reintentar. Revisar los clientes activos en Supabase y la disponibilidad de cada servicio. Las conexiones de otras aplicaciones también cuentan.
4. Confirmar `/health/ready` y probar una historia de texto, otra con foto y otra con video en cuentas de prueba. Verificar que la segunda cuenta pueda abrirla y que el creador vea sus estadísticas. El fixture local comprueba el SDK y las reglas, pero no sustituye esta comprobación del proveedor desplegado.

## Presupuesto para servicios futuros

Con dos APIs y un proceso por API, el máximo local conjunto es 6. Con dos despliegues que solapen procesos antiguos y nuevos puede llegar a 12, dejando margen hasta 15. Calcular todos los procesos y aplicaciones que usen esa base antes de añadir servicios; repartir el presupuesto por proceso. Tener más APIs no amplía la capacidad común de PostgreSQL.

Supabase ofrece un pooler de transacciones en el puerto 6543, que asigna conexiones durante transacciones. Migrar a ese modo requiere validar migraciones y coordinación y actualizar coherentemente la huella del cluster y los clientes publicados, porque el puerto forma parte de esa huella. Nivra desactiva la preparación automática de sentencias al usar ese puerto. Fuentes: [conexión a PostgreSQL](https://supabase.com/docs/guides/database/connecting-to-postgres), [pooling y límites](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits), [parámetros de Npgsql](https://www.npgsql.org/doc/connection-string-parameters).
