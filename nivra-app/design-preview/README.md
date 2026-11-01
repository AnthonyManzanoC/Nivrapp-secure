# Revisión visual aislada

Desde `nivra-app`:

```powershell
npm run preview:design
```

Abre `http://127.0.0.1:8102/app/chats`. Renderiza los componentes reales Shell, Chats y Bienvenida con servicios de prueba, nombres ficticios y sin conexiones a la API. Permite revisar filtros, búsqueda local, menú, diálogo de grupos y temas claro/oscuro sin entrar en una cuenta real.

La entrada está declarada únicamente en la configuración `design-preview`. `src/main.ts` y la compilación de producción no la importan. La ruta de conversación usa una cabecera de prueba con las hojas de estilo reales de ChatDetail; el contenido no tiene mensajes de usuario. Permite revisar la flecha de navegación al cruzar 768/769 px, la lista de tres líneas y sus etiquetas sin repetir. Los controles permiten cambiar tema y densidad; `?theme=light` abre el tema claro. No simula envío, llamadas ni funciones de servidor.
