# Sistema Visual Patagónica — Facturación y cobranza

Estándar de diseño para portales y apps internas de Patagónica Inmobiliaria
(facturación, cobranza, órdenes de compra, etc.). Fuente original: prototipo
`26108-PrototipoPatagonica` (agencia de diseño, v1, 07/10/2026), guardado en
`C:\Users\ALEX MELENDEZ\Downloads\26108-PrototipoPatagonica`.

No variar esta paleta/tipografía/medidas salvo pedido explícito — el objetivo
es que todas las apps de Patagónica se vean como un mismo sistema.

## Principios

1. **Un solo tema claro.** Navy solo para estructura (barra lateral) y acción
   primaria. Fondo crema, superficies blancas.
2. **Cifras primero.** Números tabulares, montos alineados a la derecha,
   formatos estrictos de UF, CLP, RUT y fecha (ver tabla de formatos).
3. **El color comunica estado.** Los sitios son chips neutros. El color se
   reserva para estados y para las dos series (Arriendo, Serv. adm.).
4. **Filtros ≠ acciones.** Búsqueda y filtros a la izquierda; acciones
   secundarias a la derecha; una sola acción primaria por pantalla.

## Tokens (CSS)

```css
:root {
  /* estructura */
  --navy: #0F153E;        --bg: #FBFAF6;          --surface: #FFFFFF;
  --line: #E6E4DC;        --line-control: #D9D7CE; --line-soft: #EFEEE9;
  --head: #F6F5F0;        --chip: #EFEEE9;        --hover: #FAF9F5;
  /* texto */
  --ink: #1A1D2E;         --ink-2: #6B6E7B;       --ink-3: #9A9CA6;
  /* series */
  --arriendo: #79C9E9;    --arriendo-ink: #2B7FA6; --arriendo-soft: #E4F4FB;
  --servadm: #F6DE62;     --servadm-ink: #9A7B10;  --servadm-soft: #FCF5D3;
  /* estados (texto / fondo) */
  --ok: #1F7A4D;          --ok-soft: #E8F3EC;
  --warn: #B26B00;        --warn-soft: #FBF0DC;
  --bad: #B42318;         --bad-soft: #FBE9E7;
  --bad-2: #7A1A12;       --bad-2-soft: #F1E2E0;
  /* tipografía */
  --font: 'Inter', system-ui, sans-serif;  /* + font-variant-numeric: tabular-nums siempre en cifras */
  /* radios */
  --r-chip: 4px; --r-control: 6px; --r-card: 8px; --r-pill: 999px;
  /* medidas */
  --header-h: 52px; --control-h: 30px; --row-h: 44px; --row-h-compact: 36px;
  --sidebar-w: 208px; --sidebar-w-collapsed: 56px; --panel-w: 420px;
}
```

Escala para distinguir años/series en gráficos de 4 pasos (claro→oscuro, NO
tonos distintos por año — un solo hue secuencial):
- **Arriendo** (azul): `#D3ECF7` (2023) → `#A6DAF0` (2024) → `#79C9E9` (2025) → `#2B7FA6` (2026)
- **Serv. administrativos** (ámbar): `#FBF2C4` (2023) → `#F9E894` (2024) → `#F6DE62` (2025) → `#C9A227` (2026)
- Escala de sitios en gráficos (navy→celeste, gris para "Sin sitio"): `#0F153E` `#24407A` `#2B7FA6` `#79C9E9` `#B5E0F2` `#9A9CA6`

Estados (texto / fondo):
| Estado | Texto | Fondo | Uso |
|---|---|---|---|
| Pagado | `#1F7A4D` | `#E8F3EC` | Pagado, al día, coincide |
| Por revisar | `#B26B00` | `#FBF0DC` | 31–90 días, diferencias, vacantes |
| Sin PDF | `#B42318` | `#FBE9E7` | Mora > 90 días, sin PDF, deuda |
| +365 días | `#7A1A12` | `#F1E2E0` | Deuda de más de un año (nunca morado) |
| Enviado | `#0F153E` | `#E7E9F3` | Enviado, afecto |
| Pendiente | `#3B4266` | `#EEF0F5` | Pendiente dentro de plazo, ocupado |

## Tipografía

Una sola familia (**Inter**, pesos 400/500/600/700) para todo, incluidos RUT,
folios e IDs. Siempre `font-variant-numeric: tabular-nums` en cifras.

| Elemento | Spec |
|---|---|
| Título de página | 16px · 600 |
| Título de sección | 13–14px · 600 |
| KPI | 20px · 600 (destacado 22px) |
| Etiqueta | 11px · 600 · MAYÚSCULAS · 0,04em |
| Cuerpo de tabla | 13px · 400 (nombres 500, montos 600) |
| Botones y chips | 12px · 500 (primaria 600) |
| Secundario | 11–12px · 400 · `#6B6E7B` |
| Navegación | 12,5px · 500 |
| Grupo de navegación | 10,5px · 600 · MAYÚSCULAS · 0,06em |

## Formatos de datos

| Dato | Correcto | Nunca |
|---|---|---|
| UF tabla | `13.338,45 UF` | `13338.45 UF` |
| UF KPI | `144.362 UF` | `144.362,45 UF` |
| CLP | `$548.640.000` | `$548640000` |
| CLP abreviado | `$548,6 M` | `$5937,8M` |
| RUT | `97.030.000-7` | `97030000-C` |
| Fecha tabla | `07/10/2026` | `2026-10-07` |
| Período | `Oct 2026` | `Octubre de 2026` |
| Vacío | `—` | `0 / vacío / N/A` |

## Espaciado, bordes, medidas

- Separación entre bloques: 14px. Relleno de tarjetas: 12–14px. Página: 16×20px.
- Radios: 4px chips · 6px botones/inputs · 8px tarjetas · 999px badges.
- Bordes: superficie `#E6E4DC` (1px) · inputs/botones `#D9D7CE` · divisores internos `#EFEEE9`.
- Medidas fijas: encabezado 52px · botón/input 30px · chip segmentado 24px ·
  badge de estado 22px · chip de sitio 20px · fila de tabla 44px (compacta 36px) ·
  panel lateral 420px · sidebar 208px (colapsada 56px).

## Íconos

Lucide (línea), lienzo 24×24, trazo 1,5px, puntas/uniones redondeadas, color
heredado del texto. 16px en navegación, 14px en botones. **Nunca emojis.**

## Componentes clave

- **Botones (30px):** una sola primaria por pantalla (navy sólido). Secundaria
  con borde `#D9D7CE`. Acciones masivas piden confirmación en modal.
- **Chips segmentados** (filtro con contador): fondo `#F6F5F0`, chip activo
  blanco con sombra sutil, contador en gris a la derecha del label.
- **Chip de sitio:** siempre neutro (`#EFEEE9` fondo, `#0F153E` texto, 20px,
  4px radio). El color va en el concepto (Arriendo/Serv.Adm), no en el sitio.
- **Barra de antigüedad de deuda:** apilada, 10px alto, 2px gap entre
  segmentos, leyenda debajo con rango + monto + %.
- **Franja de KPIs:** una sola superficie con divisores internos, NO tarjetas
  sueltas. Etiqueta arriba (11px mayúsculas) · cifra 20px · cifra secundaria
  (CLP o variación ▲/▼) abajo.
- **Tabla de datos:** buscador a la izquierda de la barra de filtros, acciones
  secundarias a la derecha. Fila 44px (compacta 36px), cabecera fija 36px
  fondo `#F6F5F0`, hover `#FAF9F5`. Montos a la derecha. RUT junto al nombre
  en 11px gris. Clic en fila abre panel lateral (420px).
- **Barra lateral:** 208px expandida / 56px colapsada, fondo navy. Logo PNG
  original sin alterar (`assets/logo-patagonica.png`). Grupos: Resumen ·
  Facturación · Clientes y contratos · Activos.
- **Encabezado de página (52px):** título + grupo de navegación · UF del día
  con fecha y fuente · selector de período · botón Actualizar con hora.
- **Estado de carga:** esqueletos `#ECEAE3` con la forma del contenido
  (shimmer). Nunca pantalla vacía.

## Dónde está el prototipo completo

12 pantallas de referencia (capturas "antes/después" + archivo interactivo
`Facturacion Patagonica v2.dc.html`) en
`C:\Users\ALEX MELENDEZ\Downloads\26108-PrototipoPatagonica`. Antes de
rediseñar cualquier pantalla de esta app (o de solicitud-compra / notas-patagonica),
revisar ahí primero si ya existe una referencia visual para esa pantalla.
