# BPLAY CRM: landing + chat propio + bot que responde como vos

**Circuito principal:** anuncio en Meta → landing (`/`) con el chat integrado → bot + vos desde el panel → link oficial de BPLAY → primera carga.
WhatsApp es opcional: si algún día conectás un número, entra a la misma bandeja.

## Novedades
- **Landing en `/`:** título, bonos por provincia, señales de confianza, pasos, preguntas frecuentes y el chat integrado. Todo se edita desde **Bot → Landing**. El Pixel registra *PageView*, *Lead* (cuando la persona deja sus datos) y *LinkRegistro* (cuando el bot le manda el link).
- **Cuenta oficial de carga por provincia:** se carga en **Bot → Provincias**. El bot pasa sólo la de la provincia del cliente y nunca otra.
- **Entrenar para que responda como vos (Bot → Entrenar):**
  1. Subí chats tuyos exportados de WhatsApp (ideal: los que terminaron en carga) y poné cómo figurás vos en el chat. La IA arma tu guía de estilo y saca tus mejores respuestas como ejemplos.
  2. En la bandeja, pasá el mouse por una respuesta del bot y tocá **✏️ Corregir**: escribís cómo lo dirías vos y queda como ejemplo con prioridad.
  3. Cada semana, usá el **Laboratorio** para comparar las charlas que convirtieron con las que no.
- **Filtro por canal** en la bandeja (web / WhatsApp).
- **Links con etiqueta:** `tudominio.com/?src=reactivacion` o con UTMs. Cada contacto queda con su origen y en **Métricas → Por origen** ves cuántos cargaron de cada fuente.

Sistema propio, sin ManyChat:

- **El jugador escribe a WhatsApp normal.** Los mensajes entran por la API oficial de Meta (Cloud API) a tu servidor.
- **Panel `/admin`:** bandeja en vivo, ficha de cada contacto (nombre, teléfono, provincia, etapa, notas), y la opción de tomar la conversación cuando quieras.
- **Bot con IA (Claude):** responde solo, manda el link de afiliado de cada provincia, acompaña el registro y la primera carga, y deriva a un humano cuando hace falta.
- **Chat web de respaldo `/chat`:** se ve como un chat de mensajería y cae en la misma bandeja. Si Meta te restringe el número, seguís operando y los contactos no se pierden.
- **Mejora continua:** cada cambio del guion queda como una versión nueva y en Métricas ves cuál trae más primeras cargas. El "Laboratorio" lee las charlas ganadas y perdidas y te propone un guion mejor.

---

## 1. Subirlo a Railway (10 minutos)

1. Creá un repo nuevo en GitHub (por ejemplo `bplay-crm`) y subí esta carpeta tal cual (el `.gitignore` ya excluye `node_modules` y `data`).
2. En Railway: **New Project → Deploy from GitHub repo →** elegí `bplay-crm`.
3. **Volumen (importante, si no, perdés los datos en cada deploy):** en el servicio, **Settings → Volumes → Add Volume**, con mount path `/data`.
4. **Variables:** cargá las de `.env.example`:
   - `ADMIN_PASSWORD`: tu contraseña del panel.
   - `ANTHROPIC_API_KEY`: sacala de console.anthropic.com → API Keys.
   - `DATA_DIR=/data`
   - Las de WhatsApp, que salen del paso 2.
5. **Settings → Networking → Generate Domain.** Si querés, conectá un subdominio tuyo (por ejemplo `chat.tudominio.com`).
6. Entrá a `https://TU-DOMINIO/admin`.

Sin `ANTHROPIC_API_KEY` el bot funciona en modo básico: pregunta la provincia y manda el link. Con la key responde con IA.

## 2. Conectar WhatsApp (API oficial)

> Un número sólo puede estar conectado en un lugar. Si hoy está en ManyChat, desconectalo de ahí primero, o usá un número nuevo.

1. Entrá a **developers.facebook.com → Mis apps → Crear app → tipo "Empresa"** y asociala a tu Business Manager.
2. Agregá el producto **WhatsApp** y registrá y verificá el número en **WhatsApp → Configuración de la API**.
3. Generá un **token permanente:** Business Manager → Usuarios del sistema → creá uno con rol Admin → asignale la app y la cuenta de WhatsApp → **Generar token** con los permisos `whatsapp_business_messaging` y `whatsapp_business_management`.
4. En Railway cargá:
   - `WA_TOKEN`: el token permanente.
   - `WA_PHONE_NUMBER_ID`: el "Identificador del número de teléfono", no el número.
   - `WA_VERIFY_TOKEN`: una palabra secreta que elijas.
   - `WA_APP_SECRET`: Configuración de la app → Básica → Clave secreta.
5. En **WhatsApp → Configuración → Webhook** pegá la URL y el token que te muestra el panel en **Conexión**, y suscribite al campo **messages**.
6. Mandá un WhatsApp al número: tiene que aparecer en la bandeja y el bot responde.

**Regla de las 24 h de WhatsApp:** pasadas 24 h desde el último mensaje del cliente, sólo se pueden mandar plantillas aprobadas por Meta. El CRM lo respeta solo:
- Te avisa en la conversación.
- Los seguimientos automáticos usan la plantilla que configures en **Bot → Seguimientos**.
- Creá la plantilla en el Administrador de WhatsApp, en la categoría Marketing o Utilidad, con una variable `{{1}}` para el nombre.

## 3. Chat web en la landing

Pegá esto antes de `</body>` en la landing (el panel en **Conexión** te lo da con tu dominio):

```html
<script src="https://TU-DOMINIO/widget.js" defer></script>
```

- Cualquier botón con `data-open-chat` abre el chat: `<a href="#" data-open-chat>Hablar con un asesor</a>`.
- Los parámetros `?prov=PBA&utm_source=meta&utm_campaign=X` de la landing pasan al chat y quedan en **Origen**, así medís qué anuncio convierte.
- El chat pide nombre, celular, provincia y confirmación de +18 antes de arrancar, así nunca perdés el contacto.
- Se puede instalar como app en el celular y manda **notificaciones push** cuando respondés: es un canal propio que no depende de Meta.

## 4. Uso diario

- **Bandeja:** los filtros "Necesita humano" y "Sin leer" son tu lista de tareas. Si escribís vos, el bot se pausa en esa charla; lo reactivás con el switch.
- **Etapas:** Nuevo → Link enviado → Registrado → Validado → Primera carga → Activo. El bot las mueve solo según lo que le dice el cliente. Cuando cruces con el reporte de BPLAY, corregí a mano las que hagan falta, porque las métricas salen de acá.
- **Bot:** cargá el **bono vigente de cada provincia**. Si no lo cargás, el bot no inventa: dice que el bono se ve al registrarse.
- **Mejorar la conversión:** una vez por semana, entrá a **Bot → Laboratorio → Analizar**, revisá la propuesta, aplicala con una nota y en 7 días comparás versiones en **Métricas → Por versión del guion**.
- **Contactos:** exportá a CSV cuando quieras. Para importar, el CSV necesita columnas de nombre, teléfono y, opcionalmente, provincia.

## Reglas fijas del bot (no se pueden desactivar)

- Sólo atiende a mayores de 18.
- No promete ganancias.
- Si alguien menciona problemas con el juego, le habla de juego responsable y lo deriva.
- No pide contraseñas, tarjetas ni fotos del DNI por chat.
- No inventa bonos.

Esto protege tu cuenta de afiliado y tu número.

## Correr local (opcional)

```bash
npm install
cp .env.example .env   # completá ADMIN_PASSWORD y, si querés, la API key
npm start              # http://localhost:3000/admin
```
