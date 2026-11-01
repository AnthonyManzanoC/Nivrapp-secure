# Double Ratchet conservando la licencia de Nivra

Decisión del propietario, 1 de noviembre de 2026: conservar la licencia actual y revisar una alternativa al motor AGPL. No se cambia la licencia general, no se publica un instalador con libsignal y no se activa el piloto en producción.

## Trabajo comprobado que se conserva

La [ejecución 41334635926](https://github.com/AnthonyManzanoC/Nivrapp-secure/actions/runs/41334635926) aprobó el envío integrado, el historial por páginas, los cuerpos compartidos para grupos, las pruebas del servidor/PostgreSQL, el puente WASM y los clientes de ensayo Android y Electron en Windows/Linux. Es evidencia de la integración experimental; no certifica un motor sustituto ni constituye una auditoría externa de Nivra.

Se conservan los contratos de almacenamiento cifrado, comparación atómica de revisiones, cola exacta de reintentos, recuperación de entregas antes de confirmar historial, aprobación entre dispositivos y compatibilidad con el historial AES-GCM anterior. Las sesiones privadas de Double Ratchet no se copian entre equipos.

## Alternativa seleccionada para evaluar

[vodozemac 0.11.1](https://github.com/matrix-org/vodozemac/releases/tag/0.11.1), commit `3e11ae87d157da6bcac3cbf7825d37c8f5ed60af`. Implementa Olm/Double Ratchet en Rust. Su [licencia Apache-2.0](https://github.com/matrix-org/vodozemac/blob/3e11ae87d157da6bcac3cbf7825d37c8f5ed60af/LICENSE) permite integrar la dependencia conservando los avisos y condiciones correspondientes, sin adoptar AGPL para Nivra.

El proyecto recibió una [auditoría de Least Authority en 2022](https://matrix.org/blog/2022/05/16/independent-public-audit-of-vodozemac-a-native-rust-reference-implementation-of-matrix-end-to-end-encryption/). Esa auditoría no cubre todos los cambios posteriores ni nuestra integración. La [versión 0.10](https://github.com/matrix-org/vodozemac/releases/tag/0.10.0) incorporó rechazo de resultados X25519 no contributivos y verificación estricta de firmas; se evalúa la versión posterior 0.11.1, no versiones anteriores.

No se elige libolm: sus mantenedores lo [declararon obsoleto](https://matrix.org/blog/2024/08/libolm-deprecation/).

## Condiciones técnicas de la sustitución

- Usar únicamente las sesiones Olm de la versión fijada y mantener la capa de contenido AES-256-GCM de Nivra. No introducir criptografía propia para sustituir el núcleo.
- Desactivar `libolm-compat`, `insecure-pk-encryption`, configuraciones experimentales y compilaciones de fuzzing; comprobar también las licencias y características efectivas de las dependencias.
- Distinguir la nueva suite en el directorio, preclaves, sobres y estado local. Olm no es compatible con los paquetes Signal del laboratorio; no se debe identificar un formato como el otro.
- Autenticar las claves públicas nuevas mediante la continuidad de identidad ya implementada, sin reutilizar la llave ECDH como llave de firma.
- No permitir que el almacén de preclaves descarte automáticamente una llave aún necesaria: comprobar capacidad antes de generar y probar reposición, consumo y reinicio.
- Probar sesiones simultáneas, mensajes desordenados y repetidos, alteración del cuerpo, cambios de cuenta, cierre del proceso, escritura fallida y transferencia de historial aprobada.
- Repetir las pruebas de navegador, Android y Windows antes de incorporar el sustituto a instaladores. La auditoría del proveedor no sustituye estas comprobaciones.

Olm proporciona el trinquete clásico. Esta evaluación no atribuye propiedades poscuánticas al sustituto. El cifrado publicado 8.0.1 sigue funcionando mientras se completa y verifica el cambio.
