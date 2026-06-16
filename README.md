# Filmaffinity Lists — Stremio Addon

Addon de Stremio que convierte listas públicas de Filmaffinity en catálogos navegables dentro de Stremio. Soporta múltiples usuarios, cada uno con sus propias listas.

## Características

- Scrapea listas públicas de Filmaffinity y las muestra como catálogos en Stremio
- Resolución automática de IDs de IMDb (usa la API de sugerencias de IMDb + título original de Filmaffinity como fallback)
- Multi-usuario: cada persona configura sus propias listas mediante una página web, sin tocar código
- Caché en disco para evitar scraping y búsquedas repetidas
- Posters incluidos directamente desde Filmaffinity
- Preparado para despliegue en Render u otros servicios cloud

## Requisitos

- Node.js 16 o superior
- npm

## Instalación y ejecución local

```bash
git clone <url-del-repo>
cd addon-stremio-filmaffinity
npm install
npm start
```

El servidor arranca en `http://127.0.0.1:7000` por defecto.

## Configurar tus listas

1. Abre `http://127.0.0.1:7000/configure` en el navegador
2. Introduce tu **User ID** de Filmaffinity (lo encuentras en la URL de tus listas: `filmaffinity.com/es/userlist.php?user_id=XXXXXXX&list_id=...`)
3. Añade una o más listas con su **List ID**
4. Opcionalmente, pon un nombre/alias personalizado para cada lista
5. Haz clic en **Generar URL de instalación**
6. Copia la URL generada

## Instalar en Stremio

1. Abre Stremio
2. Ve a la sección de addons (icono de puzzle)
3. En la barra de búsqueda de addons, pega la URL de instalación que generaste
4. El addon aparecerá como **Filmaffinity Lists** con tus catálogos

Cada lista se mostrará como dos catálogos separados: uno para películas y otro para series.

## Configurar para otra persona

Simplemente envíale el enlace `http://tu-servidor/configure`. Cada persona genera su propia URL de instalación con sus listas, sin afectar a nadie más. No se necesita base de datos: toda la configuración viaja codificada en la URL de instalación.

## Variables de entorno

| Variable | Descripción | Valor por defecto |
|----------|-------------|-------------------|
| `PORT` | Puerto del servidor | `7000` |
| `BASE_URL` | URL pública del addon (para generar URLs de instalación) | `http://127.0.0.1:PORT` |
| `CACHE_HOURS` | Horas de validez de la caché de listas scrapeadas | `8` |

## Despliegue en Render

1. Sube el código a un repositorio de GitHub
2. En [Render](https://render.com), crea un nuevo **Web Service**
3. Conecta tu repositorio
4. Configura:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment Variables**:
     - `BASE_URL`: `https://tu-app.onrender.com` (la URL que Render te asigne)
5. Despliega

Una vez desplegado, comparte `https://tu-app.onrender.com/configure` con quien quiera usar el addon.

## Estructura del proyecto

```
├── index.js              # Servidor HTTP y lógica del addon
├── configure.html        # Página de configuración multi-usuario
├── lib/
│   ├── scraper.js        # Scraping de listas de Filmaffinity
│   ├── imdb-resolver.js  # Resolución de IDs de IMDb
│   ├── cache.js          # Caché en memoria y disco
│   └── config.js         # Codificación/decodificación de configuración
├── cache/                # Datos cacheados (generado automáticamente)
├── package.json
└── README.md
```

## Resolución de IDs de IMDb

El addon resuelve automáticamente los títulos de Filmaffinity a IDs de IMDb usando:

1. **API de sugerencias de IMDb** con el título en español
2. Si no encuentra resultado, busca con el **título simplificado** (sin subtítulo)
3. Si sigue sin encontrarlo, scrapea la **ficha de Filmaffinity** para obtener el **título original** y busca con ese

Los resultados se cachean en `cache/imdb-map.json`. Los títulos que no se resuelvan se omiten del catálogo y se registran en la consola.

## Notas

- Solo funciona con listas **públicas** de Filmaffinity
- Las listas muy nuevas o de películas sin estrenar pueden no resolverse si IMDb aún no tiene la ficha
- La caché se refresca automáticamente cada 8 horas (configurable con `CACHE_HOURS`)
