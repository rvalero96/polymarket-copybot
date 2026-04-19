from strategies.base import Strategy
from strategies.btc5m.engine import run_btc5m
from logger import logger


class Btc5mStrategy(Strategy):
    name = "btc5m"
    enabled = True

    def get_schedule(self) -> str:
        return "*/5 * * * *"  # cada 5 minutos

    async def run(self) -> None:
        logger.info("btc5m:cycle:start")
        await run_btc5m()
        logger.info("btc5m:cycle:done")
