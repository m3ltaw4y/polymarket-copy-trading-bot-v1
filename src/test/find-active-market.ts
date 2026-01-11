import createClobClient from '../utils/createClobClient';
import { Side, OrderType } from '@polymarket/clob-client';
import axios from 'axios';

/**
 * Aggressively searches for an active market with liquidity
 * and attempts to place a small test order
 */
const findAndTestMarket = async () => {
    console.log("🔍 Searching for active markets with liquidity...\n");

    const clobClient = await createClobClient();

    // Try multiple API endpoints to find active markets
    const apiEndpoints = [
        'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&sort=volume',
        'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&sort=liquidity',
        'https://data-api.polymarket.com/markets?limit=50&active=true'
    ];

    let allMarkets: any[] = [];

    for (const endpoint of apiEndpoints) {
        try {
            console.log(`Fetching from: ${endpoint.split('?')[0]}...`);
            const response = await axios.get(endpoint);
            const markets = Array.isArray(response.data) ? response.data : response.data.data || [];
            allMarkets = allMarkets.concat(markets);
            console.log(`  Found ${markets.length} markets`);
        } catch (e: any) {
            console.log(`  Failed: ${e.message}`);
        }
    }

    console.log(`\n📊 Total markets to check: ${allMarkets.length}\n`);

    let foundMarket = null;
    let foundTokenID = null;
    let foundPrice = 0;
    let checkedCount = 0;

    for (const market of allMarkets) {
        let tokenIds = market.clobTokenIds || market.tokens?.map((t: any) => t.token_id);

        if (typeof tokenIds === 'string') {
            try { tokenIds = JSON.parse(tokenIds); } catch (e) { tokenIds = [tokenIds]; }
        }

        if (!tokenIds || !Array.isArray(tokenIds) || tokenIds.length === 0) continue;

        for (const tokenID of tokenIds) {
            if (!tokenID || typeof tokenID !== 'string') continue;

            checkedCount++;
            process.stdout.write(`\rChecking token ${checkedCount}...`);

            try {
                const orderbook = await clobClient.getOrderBook(tokenID);

                if (orderbook && orderbook.asks && orderbook.asks.length > 0 &&
                    orderbook.bids && orderbook.bids.length > 0) {

                    const bestAsk = orderbook.asks[0];
                    const bestBid = orderbook.bids[0];
                    const askPrice = parseFloat(bestAsk.price);
                    const bidPrice = parseFloat(bestBid.price);
                    const spread = askPrice - bidPrice;

                    // Look for markets with tight spreads (more liquid)
                    if (spread < 0.1 && askPrice > 0.1 && askPrice < 0.9) {
                        foundMarket = market;
                        foundTokenID = tokenID;
                        foundPrice = askPrice;
                        console.log(`\n\n✅ FOUND ACTIVE MARKET!`);
                        console.log(`   Question: "${market.question || market.description || 'Unknown'}"`);
                        console.log(`   Token ID: ${tokenID}`);
                        console.log(`   Best Ask: ${askPrice}`);
                        console.log(`   Best Bid: ${bidPrice}`);
                        console.log(`   Spread: ${(spread * 100).toFixed(2)}%`);
                        console.log(`   Ask Size: ${bestAsk.size} shares`);
                        break;
                    }
                }
            } catch (e) {
                // Skip silently
            }
        }

        if (foundMarket) break;
    }

    if (!foundMarket) {
        console.log(`\n\n❌ Could not find any active orderbook after checking ${checkedCount} tokens`);
        console.log("This might indicate:");
        console.log("  - Markets are currently very inactive");
        console.log("  - API is returning stale data");
        console.log("  - Network connectivity issues");
        return;
    }

    // Attempt to place a small test order
    console.log(`\n\n🧪 ATTEMPTING TEST ORDER...`);
    console.log(`   Amount: $0.10 USDC`);
    console.log(`   Side: BUY`);
    console.log(`   Price: ${foundPrice}\n`);

    try {
        const order = await clobClient.createMarketOrder({
            tokenID: foundTokenID!,
            amount: 0.10,
            side: Side.BUY,
            price: foundPrice,
        });

        const response = await clobClient.postOrder(order, OrderType.FOK);

        console.log("📋 Order Response:");
        console.log(JSON.stringify(response, null, 2));

        if (response.success) {
            console.log("\n🎉 SUCCESS! Test order placed!");
        } else if (response.error === 'invalid signature') {
            console.log("\n⚠️  Order failed due to Gnosis Safe signature issue");
            console.log("   This is expected if PROXY_WALLET is not a properly configured Safe");
            console.log("   However, we confirmed that:");
            console.log("   ✅ Active orderbook exists");
            console.log("   ✅ Order creation works");
            console.log("   ✅ API communication works");
            console.log("\n   To fix signature issues, you need to either:");
            console.log("   1. Use a properly configured Gnosis Safe wallet, OR");
            console.log("   2. Switch to EOA signature type (I can help with this)");
        } else {
            console.log(`\n❌ Order failed: ${response.error || 'Unknown error'}`);
        }
    } catch (e: any) {
        console.log(`\n❌ Exception during order placement: ${e.message}`);
    }
};

findAndTestMarket();
