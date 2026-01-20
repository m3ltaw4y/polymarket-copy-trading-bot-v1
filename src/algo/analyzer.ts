import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

interface Trade {
    timestamp: number;
    transactionHash: string;
    side: string;
    size: number;
    usdcSize: number;
    price: number;
    asset: string;
    title: string;
    marketId: string;
}

interface PriceAnalysis {
    timestamp: string;
    timestampUnix: number;
    side: string;
    amount: number;
    market: string;
    transactionHash: string;
    btc_price_at_trade: number | null;
    btc_price_1m_before: number | null;
    btc_price_5m_before: number | null;
    btc_price_15m_before: number | null;
    price_change_1m: string;
    price_change_5m: string;
    price_change_15m: string;
    interpretation: string;
}

interface AnalysisResult {
    analysis_period: {
        start: string;
        end: string;
        total_trades: number;
        filtered_trades: number;
    };
    trades: PriceAnalysis[];
    patterns: {
        avg_price_change_1m: string;
        avg_price_change_5m: string;
        avg_price_change_15m: string;
        directional_accuracy: string;
        notes: string;
    };
}

// Binance K-line format: [openTime, open, high, low, close, volume, closeTime, ...]
type BinanceKline = [number, string, string, string, string, string, number, string, number, string, string, string];

async function fetchBinanceHistory(startTime: number, endTime: number): Promise<Map<number, number>> {
    const priceMap = new Map<number, number>();
    try {
        // Fetch 1m candles
        // Binance API limit is 1000 candles per request
        const url = `https://api.binance.com/api/v3/klines`;
        const params = {
            symbol: 'BTCUSDT',
            interval: '1m',
            startTime: startTime * 1000,
            endTime: endTime * 1000,
            limit: 1000
        };

        const response = await axios.get(url, { params });
        const klines: BinanceKline[] = response.data;

        klines.forEach(k => {
            const openTime = k[0]; // ms
            const closePrice = parseFloat(k[4]);
            // Map timestamp (seconds) to close price
            // Key is unix timestamp at start of minute
            priceMap.set(Math.floor(openTime / 1000), closePrice);
        });

        console.log(`✅ Fetched ${klines.length} BTC price points from Binance`);
    } catch (error) {
        console.error('Error fetching Binance data:', error instanceof Error ? error.message : error);
    }
    return priceMap;
}

function getPriceAtTime(priceMap: Map<number, number>, timestamp: number): number | null {
    // Find the closest candle within previous 60 seconds
    // Since we mapped openTime (start of minute), we look for key <= timestamp

    // Simple approach: round down timestamp to nearest minute
    const minuteTimestamp = Math.floor(timestamp / 60) * 60;

    // Check minute, minute-1, minute+1
    if (priceMap.has(minuteTimestamp)) return priceMap.get(minuteTimestamp)!;
    if (priceMap.has(minuteTimestamp - 60)) return priceMap.get(minuteTimestamp - 60)!;

    return null;
}

function calculatePriceChange(priceNow: number | null, priceBefore: number | null): string {
    if (priceNow === null || priceBefore === null) return 'N/A';
    const change = ((priceNow - priceBefore) / priceBefore) * 100;
    return `${change >= 0 ? '+' : ''}${change.toFixed(3)}%`;
}

export async function runHistoricalAnalysis(): Promise<void> {
    console.log('====================================');
    console.log('🔍 HISTORICAL TRADE ANALYSIS (Binance Data)');
    console.log('====================================');
    console.log(`Target User: ${ENV.USER_ADDRESS}`);
    console.log(`Title Filter: ${ENV.TITLE_FILTER || 'NONE'}`);
    console.log(`Lookback Period: ${ENV.ANALYSIS_LOOKBACK_DAYS} days`);
    console.log('====================================\n');

    // Calculate time range
    const now = Math.floor(Date.now() / 1000);
    const endTime = now;
    const startTime = endTime - (ENV.ANALYSIS_LOOKBACK_DAYS * 24 * 60 * 60);

    console.log(`📊 Fetching trades from ${new Date(startTime * 1000).toISOString()} to ${new Date(endTime * 1000).toISOString()}...\n`);

    // Fetch all trades
    const url = `https://data-api.polymarket.com/activity?user=${ENV.USER_ADDRESS}&limit=500&type=TRADE`;
    const allTrades = await fetchData(url) as Trade[];

    if (!Array.isArray(allTrades)) {
        console.error('❌ Failed to fetch trades');
        return;
    }

    // Filter trades
    const filteredTrades = allTrades.filter((trade: Trade) => {
        if (trade.timestamp < startTime || trade.timestamp > endTime) return false;
        if (ENV.TITLE_FILTER && !trade.title.toLowerCase().includes(ENV.TITLE_FILTER.toLowerCase())) {
            return false;
        }
        return true;
    });

    console.log(`Found ${filteredTrades.length} trades matching filters` + (filteredTrades.length > 0 ? '' : ' - Exiting'));
    if (filteredTrades.length === 0) return;

    // Get time range for prices (min trade time - 15m, max trade time)
    const minTradeTime = Math.min(...filteredTrades.map(t => t.timestamp));
    const maxTradeTime = Math.max(...filteredTrades.map(t => t.timestamp));
    const priceStartTime = minTradeTime - 900 - 60; // 15 mins buffer + 1 min
    const priceEndTime = maxTradeTime + 60;

    console.log(`📉 Fetching historical BTC prices from Binance (${new Date(priceStartTime * 1000).toISOString()} - ${new Date(priceEndTime * 1000).toISOString()})...`);

    const priceMap = await fetchBinanceHistory(priceStartTime, priceEndTime);

    // Analyze outcome tokens (Assets)
    // Group trades by asset ID to identify Up vs Down
    const assetVolumes = new Map<string, { count: number, volume: number, firstTime: number }>();

    filteredTrades.forEach(t => {
        if (!assetVolumes.has(t.asset)) {
            assetVolumes.set(t.asset, { count: 0, volume: 0, firstTime: t.timestamp });
        }
        const stats = assetVolumes.get(t.asset)!;
        stats.count++;
        stats.volume += t.usdcSize;
        // Keep earliest time
        if (t.timestamp < stats.firstTime) stats.firstTime = t.timestamp;
    });

    console.log('\n📊 Betting Distribution (Assets/Outcomes):');
    const sortedAssets = Array.from(assetVolumes.entries()).sort((a, b) => b[1].volume - a[1].volume);

    // Attempt to identify UP vs DOWN
    // Hypothesis: If price is rising and they buy Asset A, Asset A is likely UP.
    // We'll check the correlation of the first few trades for each asset.
    const assetLabels = new Map<string, string>();

    sortedAssets.forEach((entry, idx) => {
        const [assetId, stats] = entry;
        const label = idx === 0 ? "Outcome A (Dominant)" : "Outcome B (Hedge?)";
        assetLabels.set(assetId, label);
        console.log(`  Asset ${assetId.substring(0, 10)}... : $${stats.volume.toFixed(2)} (${stats.count} trades) - ${label}`);
    });

    // Analyze each trade
    const analyses: PriceAnalysis[] = [];
    let priceChangeSum1m = 0;
    let priceChangeSum5m = 0;
    let priceChangeSum15m = 0;

    console.log('\n📝 Analyzing trade correlations...');

    for (const trade of filteredTrades) {
        const priceAtTrade = getPriceAtTime(priceMap, trade.timestamp);
        const price1mBefore = getPriceAtTime(priceMap, trade.timestamp - 60);
        const price5mBefore = getPriceAtTime(priceMap, trade.timestamp - 300);
        const price15mBefore = getPriceAtTime(priceMap, trade.timestamp - 900);

        const change1m = calculatePriceChange(priceAtTrade, price1mBefore);
        const change5m = calculatePriceChange(priceAtTrade, price5mBefore);
        const change15m = calculatePriceChange(priceAtTrade, price15mBefore);

        // Interpretation
        let interpretation = '';
        if (priceAtTrade && price5mBefore) {
            const pctChange5m = ((priceAtTrade - price5mBefore) / price5mBefore) * 100;
            const outcomeLabel = assetLabels.get(trade.asset) || 'Unknown';

            if (pctChange5m > 0) {
                interpretation = `Price UP ${change5m} (5m), Bought ${outcomeLabel}`;
            } else {
                interpretation = `Price DOWN ${change5m} (5m), Bought ${outcomeLabel}`;
            }
        }

        analyses.push({
            timestamp: new Date(trade.timestamp * 1000).toISOString(),
            timestampUnix: trade.timestamp,
            side: trade.side,
            amount: trade.usdcSize,
            market: trade.title,
            transactionHash: trade.transactionHash,
            btc_price_at_trade: priceAtTrade,
            btc_price_1m_before: price1mBefore,
            btc_price_5m_before: price5mBefore,
            btc_price_15m_before: price15mBefore,
            price_change_1m: change1m,
            price_change_5m: change5m,
            price_change_15m: change15m,
            interpretation: interpretation + ` [Asset: ${trade.asset.substring(0, 6)}...]`
        });
    }

    const result: AnalysisResult = {
        analysis_period: {
            start: new Date(startTime * 1000).toISOString(),
            end: new Date(endTime * 1000).toISOString(),
            total_trades: allTrades.length,
            filtered_trades: filteredTrades.length,
        },
        trades: analyses,
        patterns: {
            avg_price_change_1m: "N/A",
            avg_price_change_5m: "N/A",
            avg_price_change_15m: "N/A",
            directional_accuracy: "See Asset Distribution",
            notes: `Found ${assetVolumes.size} distinct outcome tokens traded. Dominant position: ${sortedAssets[0]?.[0].substring(0, 8)}... ($${sortedAssets[0]?.[1].volume.toFixed(2)})`
        }
    };

    // Write to file
    const outputPath = path.join(process.cwd(), 'analysis-results.json');
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

    console.log('\n====================================');
    console.log('📊 ANALYSIS COMPLETE');
    console.log('====================================');
    console.log(`Total trades analyzed: ${filteredTrades.length}`);
    console.log(`Prices fetched: ${priceMap.size}`);
    console.log(`\nResults saved to: ${outputPath}`);
    console.log('====================================\n');
}
