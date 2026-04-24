#!/bin/bash
# Script para actualizar automáticamente el código desde rama PRO
# Ejecutar periódicamente con cron

cd ~/polymarket-copybot

echo "Verificando cambios en rama PRO..."

# Fetch para obtener info remota sin merge
git fetch origin

# Comparar HEAD local con origin/PRO
if git diff --quiet HEAD origin/PRO; then
    echo "$(date): No hay cambios nuevos en PRO"
else
    echo "$(date): Hay cambios, actualizando..."
    git pull origin PRO
    echo "Reiniciando servicio..."
    sudo systemctl restart polymarket-bot
    echo "Actualización completada"
fi