# OpenAI Response Debugger

Playground local para inspeccionar respuestas por ID o desde un JSON guardado y continuar conversaciones de la **Responses API**.

Incluye dos backends equivalentes:

- **Python**: solo librería estándar, sin `pip install`.
- **Node.js**: solo APIs nativas, sin `npm install`.

Ambos sirven exactamente la misma interfaz web y mantienen `OPENAI_API_KEY` en el backend; la clave no se envía al navegador.

## Qué permite hacer

- Pegar un `resp_...` y cargar esa respuesta, sin recorrer el historial.
- Exportar el objeto Response completo y abrirlo posteriormente con **Abrir JSON**, sin consultar la API.
- Consultar cada Response mediante `GET /v1/responses/{response_id}`.
- Consultar sus input items mediante `GET /v1/responses/{response_id}/input_items`.
- Ver modelo, estado, token usage, instrucciones, outputs y JSON completo.
- Continuar desde la respuesta cargada con **Continuar conversación**, siempre accesible en la barra superior.
- Enviar `instructions` explícitas para el nuevo turno.
- Añadir parámetros avanzados mediante un objeto JSON (`tools`, `tool_choice`, `reasoning`, `temperature`, etc.).
- Copiar parte de la configuración recuperable de una Response al formulario de fork.

## Requisito previo

Una API key de OpenAI con acceso al proyecto/Responses que quieras inspeccionar.

Copia el fichero de configuración:

```bash
cp .env.example .env
```

Edita `.env`:

```dotenv
OPENAI_API_KEY=sk-...
```

Si usas una organización o proyecto explícitos, también puedes completar:

```dotenv
OPENAI_PROJECT=proj_...
OPENAI_ORGANIZATION=org_...
```

## Opción A: levantar con Python

Recomendado: Python 3.10+.

```bash
python3 python/server.py
```

Después abre:

```text
http://127.0.0.1:8787
```

No hay dependencias externas.

## Opción B: levantar con Node.js

Recomendado: Node.js 20+ (requiere `fetch` y `AbortSignal.timeout`).

```bash
node node/server.mjs
```

Después abre:

```text
http://127.0.0.1:8787
```

No hay `package.json`, `npm install` ni dependencias externas.

## Windows / PowerShell

Puedes copiar el fichero con:

```powershell
Copy-Item .env.example .env
```

Y arrancar con una de estas opciones:

```powershell
python python/server.py
```

```powershell
node node/server.mjs
```

## Cómo usarlo

1. Arranca uno de los dos backends.
2. Pega un `resp_...` en **Response ID**.
3. Pulsa **Cargar**.
4. Inspecciona la salida, entrada, configuracion o JSON completo. Las herramientas y el razonamiento empiezan plegados.
5. Usa **Colapsar todo** en la barra fija para plegar todos los pasos y campos.
6. Usa **Exportar JSON completo** para guardar el objeto original; **Abrir JSON** permite volver a visualizarlo localmente.
7. Pulsa **Continuar conversación** para abrir el formulario en un dialogo, sin desplazarte al final.
8. Comprueba `instructions`: la Responses API no hereda automáticamente las instrucciones del Response anterior al usar `previous_response_id`.
9. Si necesitas reproducir tools/reasoning/configuración adicional, usa **Copiar config al JSON** y ajusta `Overrides avanzados`.
10. Pulsa **Enviar y cargar nueva rama**.

## Overrides avanzados

Ejemplo:

```json
{
  "temperature": 0.2,
  "max_output_tokens": 1000,
  "reasoning": {
    "effort": "medium"
  }
}
```

El backend protege estos campos para evitar que el JSON avanzado cambie accidentalmente la rama que estás probando:

- `previous_response_id`
- `input`
- `model`
- `instructions`
- `store`
- `conversation`

Los campos principales se toman de los controles visibles de la UI.

## Limitaciones importantes para depuración

### 1. `instructions` no se heredan

Cuando creas una Response con `previous_response_id`, las `instructions` del Response previo no se arrastran automáticamente. La UI las muestra y, cuando son texto, las precarga para que puedas decidir si quieres reenviarlas.

### 2. Tools y function calls

Una Response recuperada puede mostrar tool calls, pero para reproducir exactamente un flujo puede ser necesario volver a enviar la definición de `tools`, `tool_choice` y cualquier configuración que tu backend original añadiese. El botón **Copiar config al JSON** intenta copiar campos recuperables habituales, pero no puede reconstruir lógica externa de tus funciones.

### 3. Responses almacenadas

Solo puedes recuperar Responses que sigan disponibles en la API. Por defecto, los objetos Response almacenados tienen una ventana de retención; además, una Response creada con `store=false` no está pensada para recuperarse posteriormente por ID.

### 4. Mismo proyecto / permisos

La API key local debe tener permisos para acceder al mismo recurso/proyecto que creó la Response. Si recibes un 404 aunque el ID parezca correcto, revisa la key, proyecto y organización utilizados por el backend original.

### 5. Coste

Crear un fork es una llamada real a la API. El contexto previo de la cadena puede contar como tokens de entrada según las reglas de la Responses API.

## Seguridad

Por defecto el servidor escucha solo en:

```text
127.0.0.1
```

No expongas este debugger directamente a Internet: no incluye login ni controles de autorización. Si cambias `HOST=0.0.0.0`, protégelo detrás de autenticación y una red de confianza.

Nunca metas `.env` en Git. Ya está incluido en `.gitignore`.

## Endpoints locales

```text
GET  /api/health
GET  /api/chain?response_id=resp_...&limit=30
GET  /api/response?response_id=resp_...
POST /api/continue
```

Ejemplo de `POST /api/continue`:

```json
{
  "previous_response_id": "resp_...",
  "model": "gpt-5.6",
  "instructions": "Tus instrucciones para este turno",
  "input": "Mensaje de prueba",
  "store": true,
  "overrides": {
    "temperature": 0.2
  }
}
```

## Documentación oficial relevante

- Responses API / conversation state: https://developers.openai.com/api/docs/guides/conversation-state
- Retrieve a Response: https://developers.openai.com/api/reference/python/resources/responses/methods/retrieve
- List input items: https://developers.openai.com/api/reference/java/resources/responses/subresources/input_items/methods/list
- Create a Response: https://developers.openai.com/api/reference/cli/resources/responses/methods/create

## Inspector de respuestas

La interfaz recupera la idea de traza y arbol JSON de `DuckDbLogsTab.tsx`
anterior al commit `e66c401` del proyecto Copiloto. La implementacion es
independiente, en JavaScript nativo, sin nuevas dependencias de ejecucion.

- **Salida / traza**: pasos ordenados con todos los campos, incluidos tipos desconocidos.
- **Entrada**: elementos recuperados y errores de acceso visibles. Los backends
  actuales recuperan como maximo 100 input items por respuesta.
- **Configuracion**: instrucciones y parametros recuperables.
- **JSON completo**: objeto Response integro con campos plegables, tipos en color
  y texto largo con saltos de linea, sin recortes ni paneles de altura limitada.
- **Interpretar JSON en texto** convierte visualmente cadenas JSON en arboles.
  Desactivalo para inspeccionar las cadenas originales. Copiar y descargar
  siempre conservan el objeto original, sin esta transformacion visual.
- La busqueda abarca campos y valores de la vista activa y abre sus ramas.
  Usa las flechas o Enter / Shift+Enter para recorrer coincidencias.
  Colapsar todo limpia la busqueda.
- La busqueda y las acciones estan en una barra fija, sin historial lateral.
  El formulario para continuar se abre en un dialogo con **Continuar conversación**.
  Las respuestas creadas con `store=false` siguen visibles durante la sesion.

### Comprobacion de interfaz

`tests/inspector.mjs` usa Playwright con Edge y respuestas simuladas. No llama a
OpenAI. Con el servidor local arrancado en el puerto 8787 y Playwright disponible:

```powershell
node tests/inspector.mjs
```

Si Playwright procede de un entorno compartido, establece `PLAYWRIGHT_PATH` a
la ruta de ese modulo antes de ejecutar. No hace falta instalarlo para usar la app.
La prueba valida texto completo, JSON anidado, busqueda, plegado, descarga sin
alteraciones, campos desconocidos, errores, ramas no almacenadas y ancho movil.
Tambien genera capturas de escritorio y movil en `tests/`.

Los JSON exportados contienen el objeto Response original, incluidos los resultados
de file search devueltos por la API. Los input items son un recurso separado y no
se incluyen en ese archivo. Abrir un archivo no realiza consultas; continuar una
conversacion si requiere conexion y un Response ID disponible.
