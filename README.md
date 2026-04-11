# polymarket-copybot

Bot de paper trading para Polymarket con dos estrategias paralelas que comparten la misma base de datos SQLite persistida en la rama `paper-state`.

## Estrategias

### 1. Copy Trading (`trading.yml`)

Sigue a los mejores traders del leaderboard de Polymarket. Cada vez que uno de los wallets monitorizados abre, aumenta o cierra una posición, el bot replica la operación.

**Cadencia:** cada 2 horas  
**Discovery:** cada 6 horas actualiza el ranking de wallets

**Flujo:**
1. `ranker.js` evalúa los 50 wallets del leaderboard mensual y activa el top 10
2. `simulator.js` detecta cambios en posiciones de los wallets activos y los copia

**Parámetros clave (`config.js`):**
| Parámetro | Valor |
|---|---|
| Bankroll inicial | 1.000 USDC |
| Tamaño por trade | 5% del bankroll |
| Máx. posiciones | 10 |
| Win rate mínimo | 55% |
| ROI mínimo | 10% |
| Precio señal | 0.05 – 0.95 |

---

### 2. Early-Bird 5m (`btc5m.yml`)

Estrategia en mercados binarios de 5 minutos de BTC/ETH/SOL/XRP en Polymarket.

**Cadencia:** cada 5 minutos  
**Assets:** BTC, ETH, SOL, XRP

**Mecánica:**
- Los mercados se resuelven automáticamente vía Chainlink price feeds on-chain
- La entrada es siempre en el siguiente mercado disponible (nunca en el actual)
- La resolución binaria es: precio final **por encima** o **por debajo** del umbral

**Señales de entrada (`src/strategies/early-bird.js`):**
- **RSI(14)** sobre velas de 1 minuto (Binance API)
- **ATR(14)** como filtro de volatilidad (descarta mercados planos o caóticos)
- **Divergencia** entre el precio spot (Binance) y el precio umbral del mercado

| Condición | Entrada |
|---|---|
| RSI ≥ 58 + spot > umbral + precio UP < 0.52 | Compra UP |
| RSI ≤ 42 + spot < umbral + precio DOWN < 0.52 | Compra DOWN |

**Salida:**
- Take profit: +15% sobre el precio de entrada
- Stop loss: −10% sobre el precio de entrada
- Resolución natural del mercado si no se toca ninguno

**Parámetros:**
| Parámetro | Valor |
|---|---|
| Tamaño por trade | 5% del bankroll |
| Máx. posiciones simultáneas | 3 |
| Take profit | +15% |
| Stop loss | −10% |
| Ventana de entrada | primeros 4 min del mercado |

---

## Arquitectura

```
src/
  discovery/
    ranker.js          Puntúa y rankea wallets del leaderboard
  engine/
    simulator.js       Motor de copy trading (paper)
    btc5m.js           Motor de mercados de 5 minutos
  strategies/
    early-bird.js      Lógica de señales RSI/ATR para 5m
  services/
    polymarket/
      api.js           Cliente HTTP para Gamma/CLOB/Data APIs
      trading.js       Ejecución live (fase 2, no implementado)
  reports/
    daily.js           Informe diario en Markdown
  utils/
    db.js              Wrapper better-sqlite3 + schema
    logger.js          Logger JSON estructurado
.github/workflows/
  discovery.yml        Cron cada 6h — actualiza roster
  trading.yml          Cron cada 2h — copy trading
  btc5m.yml            Cron cada 5min — early-bird-5m
```

## Base de datos

El estado se persiste en la rama `paper-state` como `data/state.db`.

| Tabla | Descripción |
|---|---|
| `wallets` | Roster de traders monitorizados |
| `signals` | Señales de copy trading detectadas |
| `trades` | Trades ejecutados (copy trading) |
| `positions` | Posiciones abiertas (copy trading) |
| `snapshots` | Snapshots diarios de bankroll/P&L |
| `btc5m_positions` | Posiciones abiertas (early-bird-5m) |
| `btc5m_trades` | Historial de trades (early-bird-5m) |

## Variables de entorno

```
TRADING_MODE=paper     # paper únicamente (live no implementado)
LOG_LEVEL=info         # debug | info | warn | error
```

## Ejecución manual

```bash
npm run discover   # actualizar roster de wallets
npm run trade      # ciclo de copy trading
node src/engine/btc5m.js   # ciclo early-bird-5m
```
