# Letterboxd Hours

Extensión para Chrome/Edge (Manifest V3, TypeScript) que inyecta una estadística
**HOURS** (horas totales vistas) en el perfil de Letterboxd, a la izquierda de
**FILMS**, clonando los estilos nativos de la página.

![ubicación: a la izquierda de FILMS en la cabecera del perfil]

## Cómo funciona

Letterboxd no tiene API pública, así que la extensión hace *scraping* educado:

1. **Content script** (`src/content.ts`): detecta el perfil, lee el contador de
   **FILMS** del DOM, **clona** el bloque `.profile-statistic` nativo (hereda
   tipografía/colores/márgenes exactos) y lo inserta a la izquierda de FILMS.
2. **Caché** (`chrome.storage.local`): se guarda `{ username, totalFilms,
   totalMinutes, slugs }` por usuario, más una caché global `slug → runtime`.
   - Si `totalFilms` cacheado **==** FILMS del DOM → muestra las horas al instante.
   - Si el DOM tiene **más** películas → muestra el valor antiguo + un botón
     discreto **«Actualizar horas»**.
   - Sin caché → botón **«Calcular horas»** (nunca scrapeamos sin tu intención).
3. **Background service worker** (`src/background.ts`): hace el trabajo de red.
   - Recorre `/<user>/films/page/N/` para reunir los *slugs* de todas las pelis.
   - Hace `fetch` a cada `/film/<slug>/` y extrae el `runtime` (`133 mins`).
   - **Solo** descarga las pelis cuyo runtime no esté ya en la caché global, así
     «Actualizar» tras ver 3 pelis nuevas solo hace 3 peticiones.

### Rate limiting (importante)

Toda la red pasa por `src/rateLimiter.ts` (`runPool`), que limita la
**concurrencia** (4 peticiones simultáneas) y añade un **delay** (350 ms) entre
el inicio de cada petición; las páginas de listado se espacian 500 ms. Esto evita
saturar los servidores de Letterboxd y reduce el riesgo de bloqueo de IP. Ajusta
las constantes al principio de `src/background.ts` si lo necesitas.

> El worker usa `credentials:"include"`, por lo que cuenta también las entradas
> privadas/de amigos tal y como tú las ves al estar logueado.

## Estructura

```
letterboxd-hours/
├── manifest.json en → public/manifest.json
├── build.mjs              # bundler (esbuild) + copia de estáticos
├── package.json / tsconfig.json
├── public/
│   ├── manifest.json      # MV3
│   └── icons/             # icon16/48/128.png
└── src/
    ├── types.ts           # tipos + claves de storage + nombre de Port
    ├── storage.ts         # wrappers de chrome.storage.local
    ├── rateLimiter.ts     # pool de concurrencia + throttle  ← crítico
    ├── parser.ts          # regex sobre HTML (sin DOM en el worker) ← crítico
    ├── background.ts      # motor de scraping (service worker)
    └── content.ts         # detección de perfil + inyección DOM + UI
```

## Compilar

Requiere Node 18+.

```bash
npm install      # instala esbuild, typescript, @types/chrome
npm run build    # genera dist/ (background.js, content.js, manifest.json, icons)
# o, en desarrollo:
npm run watch    # recompila al guardar
npm run typecheck
```

El resultado queda en `dist/`, que es la carpeta que se carga en el navegador.

## Cargar en el navegador

**Chrome:** ve a `chrome://extensions` → activa **Modo desarrollador** →
**Cargar descomprimida** → selecciona la carpeta **`dist/`**.

**Edge:** ve a `edge://extensions` → activa **Modo de desarrollador** →
**Cargar desempaquetada** → selecciona **`dist/`**.

Abre cualquier perfil (p. ej. `https://letterboxd.com/iagoesteevezz/`), pulsa
**«Calcular horas»** una vez y, a partir de ahí, las horas aparecen al instante
hasta que añadas más películas.

## Notas y límites

- Los selectores dependen del HTML de Letterboxd (verificados en junio 2026:
  `data-film-slug` en los pósters, `133&nbsp;mins` en `p.text-footer`,
  `.profile-statistic > .value/.definition`). Si Letterboxd cambia su markup,
  actualiza `src/parser.ts` y `findStats()` en `src/content.ts`.
- Las pelis sin runtime publicado cuentan como 0 min (se cachean igualmente).
- La primera pasada de un perfil grande tardará (por el rate limiting); es
  intencionado. Las siguientes son casi instantáneas gracias a la caché.
```
