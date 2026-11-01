# Revisión visual aislada

Desde `nivra-app`:

```powershell
npm run preview:design
```

Abre `http://127.0.0.1:8102/app/chats`. Renderiza los componentes reales Shell, Chats y Bienvenida con servicios de prueba, nombres ficticios y sin conexiones a la API. Permite revisar filtros, búsqueda local, menú, diálogo de grupos y temas claro/oscuro sin entrar en una cuenta real.

La entrada está declarada únicamente en la configuración `design-preview`. `src/main.ts` y la compilación de producción no la importan. Las rutas de conversación y otras pestañas muestran un aviso de vista de prueba; no simulan envío, llamadas ni funciones de servidor. No sirve para afirmar que una llamada real o la entrega multidispositivo hayan sido probadas.
