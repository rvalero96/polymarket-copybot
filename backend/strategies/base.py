from abc import ABC, abstractmethod


class Strategy(ABC):
    name: str
    enabled: bool = True

    @abstractmethod
    async def run(self) -> None:
        """Lógica principal de la estrategia."""

    @abstractmethod
    def get_schedule(self) -> str:
        """Cron expression, e.g. '*/5 * * * *'"""
