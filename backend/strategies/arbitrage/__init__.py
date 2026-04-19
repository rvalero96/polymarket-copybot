from strategies.base import Strategy
from strategies.arbitrage.executor import run_arbitrage
from logger import logger


class ArbitrageStrategy(Strategy):
    name = "arbitrage"
    enabled = True

    def get_schedule(self) -> str:
        return "*/30 * * * *"  # cada 30 minutos

    async def run(self) -> None:
        logger.info("arbitrage:cycle:start")
        await run_arbitrage()
        logger.info("arbitrage:cycle:done")
