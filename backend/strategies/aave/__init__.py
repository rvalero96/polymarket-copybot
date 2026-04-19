from strategies.base import Strategy
from logger import logger


class KellyStrategy(Strategy):
    """Calcula la fracción óptima de capital a desplegar en AAVE Yield."""

    name = "kelly"
    enabled = True

    def get_schedule(self) -> str:
        return "0 * * * *"  # cada hora

    async def run(self) -> None:
        logger.info("kelly:cycle:start")
        # TODO: calcular fracción Kelly y actualizar asignación hacia AAVE
        logger.info("kelly:cycle:done")


class AaveStrategy(Strategy):
    """Mueve capital hacia/desde AAVE según la asignación calculada por Kelly."""

    name = "aave"
    enabled = True

    def get_schedule(self) -> str:
        return "30 * * * *"  # cada hora (30 min después de Kelly)

    async def run(self) -> None:
        logger.info("aave:cycle:start")
        # TODO: ejecutar depósito/retirada en AAVE según fracción Kelly
        logger.info("aave:cycle:done")
