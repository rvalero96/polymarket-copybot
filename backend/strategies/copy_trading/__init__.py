from strategies.base import Strategy
from strategies.copy_trading.discovery import run_discovery
from strategies.copy_trading.simulator import run_simulator
from logger import logger


class CopyTradingStrategy(Strategy):
    name = "copy_trading"
    enabled = True

    def get_schedule(self) -> str:
        return "0 */2 * * *"  # cada 2 horas

    async def run(self) -> None:
        logger.info("copy_trading:cycle:start")
        await run_simulator()
        logger.info("copy_trading:cycle:done")


class DiscoveryStrategy(Strategy):
    name = "discovery"
    enabled = True

    def get_schedule(self) -> str:
        return "0 */6 * * *"  # cada 6 horas

    async def run(self) -> None:
        logger.info("discovery:cycle:start")
        await run_discovery()
        logger.info("discovery:cycle:done")
