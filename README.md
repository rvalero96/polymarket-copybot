# Polymarket Copybot

Bot de trading automático para Polymarket. Corre como servidor siempre activo con un backend Python (FastAPI + APScheduler) y un frontend estático.

## Estructura

```
backend/      FastAPI app, estrategias, DB SQLite
frontend/     Dashboard HTML estático servido por el backend
deploy/       nginx.conf, systemd service, script de setup
.env          Variables de entorno (no commitear)
.env.example  Plantilla de variables
requirements.txt  Dependencias Python
```

## Estrategias

| Estrategia | Frecuencia | Descripción |
|---|---|---|
| Discovery | cada 6 h | Descubre y rankea wallets a copiar |
| Copy Trading | cada 2 h | Replica posiciones de wallets top |
| BTC 5m | cada 5 min | Opera mercados BTC con señales de precio |
| Arbitrage | cada 30 min | Detecta y ejecuta oportunidades de arbitraje |

## Setup local

```bash
python3.12 -m venv backend/venv
source backend/venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # editar con tus valores
cd backend
uvicorn main:app --reload
```

El dashboard queda en `http://localhost:8000`.

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `TRADING_MODE` | `paper` | `paper` o `live` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `DB_PATH` | `data/state.db` | Ruta a la base de datos SQLite |
| `API_TOKEN` | — | Token de autenticación del dashboard |
| `PAPER_BANKROLL` | `1000` | Capital inicial en paper trading (USDC) |

## Deploy (Ubuntu 22.04+)

```bash
bash deploy/setup.sh
```

Configura Python, el servicio systemd y nginx con HTTPS (Let's Encrypt). Editar `deploy/nginx.conf` con el dominio real antes de ejecutar.

Comandos útiles post-deploy:

```bash
sudo systemctl status polymarket-bot
sudo journalctl -fu polymarket-bot
sudo systemctl restart polymarket-bot
```
