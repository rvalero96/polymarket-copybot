#!/bin/bash
# Script de setup inicial en el servidor (Ubuntu 22.04+)
# Ejecutar como: bash setup.sh

set -e

echo "=== 1. Actualizando sistema ==="
apt update && apt upgrade -y

echo "=== 2. Instalando Python 3.12 y herramientas ==="
apt install -y python3.12 python3.12-venv python3-pip nginx certbot python3-certbot-nginx git

echo "=== 3. Clonando repo ==="
cd ~
git clone -b PRO https://github.com/rvalero96/polymarket-copybot.git || true
cd polymarket-copybot
git pull origin PRO || true

echo "=== 4. Creando entorno virtual ==="
python3.12 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "=== 5. Configurando variables de entorno ==="
if [ ! -f .env ]; then
  cp .env.example .env
  echo "IMPORTANTE: edita .env y pon tu API_TOKEN seguro:"
  echo "  nano .env"
else
  echo ".env ya existe, no se sobreescribe."
fi

echo "=== 6. Creando carpeta de datos ==="
mkdir -p backend/data

echo "=== 7. Instalando servicio systemd ==="
cp deploy/polymarket-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable polymarket-bot
systemctl restart polymarket-bot

echo "=== 8. Configurando nginx ==="
cp deploy/nginx.conf /etc/nginx/sites-available/polymarket-bot
ln -sf /etc/nginx/sites-available/polymarket-bot /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "=== Setup completado ==="
echo ""
echo "Comandos útiles:"
echo "  systemctl status polymarket-bot   — ver estado"
echo "  journalctl -fu polymarket-bot     — ver logs en tiempo real"
echo "  systemctl restart polymarket-bot  — reiniciar"
echo ""
echo "Para HTTPS con Let's Encrypt (requiere dominio apuntando al servidor):"
echo "  certbot --nginx -d tu-dominio.com"
