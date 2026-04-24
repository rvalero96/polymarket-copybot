# early-bird-5m — signal logic for 5-min binary markets
# Indicators: Wilder RSI(14) on 1m candles + ATR(14) + price divergence


def compute_rsi(closes: list[float], period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None

    changes = [closes[i] - closes[i - 1] for i in range(1, len(closes))]

    avg_gain = avg_loss = 0.0
    for i in range(period):
        if changes[i] > 0:
            avg_gain += changes[i]
        else:
            avg_loss -= changes[i]
    avg_gain /= period
    avg_loss /= period

    for i in range(period, len(changes)):
        gain = changes[i] if changes[i] > 0 else 0.0
        loss = -changes[i] if changes[i] < 0 else 0.0
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period

    if avg_loss == 0:
        return 100.0
    return 100 - 100 / (1 + avg_gain / avg_loss)


def compute_atr(candles: list[dict], period: int = 14) -> float | None:
    if len(candles) < 2:
        return None

    trs = []
    for i in range(1, len(candles)):
        high      = candles[i]["high"]
        low       = candles[i]["low"]
        prev_close = candles[i - 1]["close"]
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))

    slice_ = trs[-period:]
    return sum(slice_) / len(slice_)


def generate_signal(
    spot_price: float,
    price_to_beat: float | None,
    rsi: float | None,
    atr: float | None,
    up_price: float | None,
    down_price: float | None,
) -> dict | None:
    if rsi is None:
        return None

    if atr is not None:
        atr_pct = (atr / spot_price) * 100
        if atr_pct < 0.005 or atr_pct > 0.5:
            return None

    # Mercados "Up or Down": sin umbral de precio, solo RSI + pricing del outcome
    if price_to_beat is None:
        if rsi >= 58 and up_price is not None and up_price < 0.52:
            return {"outcome": "UP"}
        if rsi <= 42 and down_price is not None and down_price < 0.52:
            return {"outcome": "DOWN"}
        return None

    # Mercados con umbral explícito (ej: "Will BTC be above $82,000?")
    divergence = (spot_price - price_to_beat) / price_to_beat

    if rsi >= 58 and divergence > 0.0005 and up_price is not None and up_price < 0.52:
        return {"outcome": "UP"}
    if rsi <= 42 and divergence < -0.0005 and down_price is not None and down_price < 0.52:
        return {"outcome": "DOWN"}

    return None
