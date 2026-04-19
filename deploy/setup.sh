#!/bin/bash
# Script de setup inicial en el servidor (Ubuntu 22.04+)
# Ejecutar como: bash setup.sh

set -e

echo "=== 1. Actualizando sistema ==="
sudo apt update && sudo apt upgrade -y

echo "=== 2. Instalando Python 3.12 y herramientas ==="
sudo apt install -y python3.12 python3.12-venv python3-pip nginx certbot python3-certbot-nginx git

echo "=== 3. Clonando repo ==="
cd ~
git clone -b PRO https://github.com/rvalero96/polymarket-copybot.git
cd polymarket-copybot

echo "=== 4. Creando entorno virtual ==="
python3.12 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "=== 5. Configurando variables de entorno ==="
cp .env.example .env
echo ""
echo "IMPORTANTE: edita backend/.env y pon tu API_TOKEN seguro:"
echo "  nano .env"
echo ""

echo "=== 6. Migrando base de datos ==="
# Copia state.db desde la rama paper-state del repo anterior
# o créala desde cero (se inicializa al primer arranque)
mkdir -p backend/data

echo "=== 7. Instalando servicio systemd ==="
sudo cp deploy/polymarket-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable polymarket-bot
sudo systemctl start polymarket-bot

echo "=== 8. Configurando nginx ==="
# Reemplaza 'tu-dominio.com' con tu dominio real en deploy/nginx.conf
sudo cp deploy/nginx.conf /etc/nginx/sites-available/polymarket-bot
sudo ln -sf /etc/nginx/sites-available/polymarket-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

echo ""
echo "=== Setup completado ==="
echo ""
echo "Comandos útiles:"
echo "  sudo systemctl status polymarket-bot   — ver estado"
echo "  sudo journalctl -fu polymarket-bot     — ver logs en tiempo real"
echo "  sudo systemctl restart polymarket-bot  — reiniciar"
echo ""
echo "Para HTTPS con Let's Encrypt (requiere dominio apuntando al servidor):"
echo "  sudo certbot --nginx -d tu-dominio.com"
