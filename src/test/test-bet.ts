import createClobClient from '../utils/createClobClient';
import { Side, OrderType } from '@polymarket/clob-client';
import axios from 'axios';

const runTestBet = async () => {
    console.log("Initializing CLOB Client...");
    const clobClient = await createClobClient();

    console.log("Fetching top active markets from Gamma API...");
    const { data: markets } = await axios.get('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&sort=volume');

    if (!markets || !Array.isArray(markets) || markets.length === 0) {
        console.error("No markets found!");
        return;
    }

    let selectedTokenID = null;
    let selectedPrice = 0;

    // Find a market with an orderbook
    for (const market of markets) {
        let tokenIds = market.clobTokenIds;

        // Handle case where clobTokenIds might be stringified or nested
        if (typeof tokenIds === 'string') {
            try {
                tokenIds = JSON.parse(tokenIds);
            } catch (e) {
                tokenIds = [tokenIds];
            }
        }

        if (!tokenIds || !Array.isArray(tokenIds) || tokenIds.length === 0) continue;

        console.log(`Checking market: ${market.question}`);

        // Iterate through outcomes in this market to find one with liquidity
        for (const tokenID of tokenIds) {
            if (!tokenID || typeof tokenID !== 'string') continue;

            try {
                const orderbook = await clobClient.getOrderBook(tokenID);
                if (orderbook && orderbook.asks && orderbook.asks.length > 0) {
                    const bestAsk = orderbook.asks[0];
                    selectedPrice = parseFloat(bestAsk.price);
                    selectedTokenID = tokenID;
                    console.log(`>> Found valid market! Token: ${tokenID}, Price: ${selectedPrice}`);
                    break;
                }
            } catch (e: any) {
                // Skip markets with errors
            }
        }

        if (selectedTokenID) break;
    }

    if (!selectedTokenID) {
        console.error("Could not find any market with an active orderbook in the top 20.");
        return;
    }

    const price = selectedPrice;
    const tokenID = selectedTokenID;

    // Use createMarketOrder for simplicity - it handles amount as USDC value
    const usdcAmount = 0.10; // $0.10 bet

    console.log(`Placing BUY market order for $${usdcAmount} worth @ ~${price}`);

    try {
        // createMarketOrder takes USDC amount, not share size
        const order = await clobClient.createMarketOrder({
            tokenID: tokenID,
            amount: usdcAmount,
            side: Side.BUY,
            price: price,
        });

        const response = await clobClient.postOrder(order, OrderType.FOK);
        console.log("\n✅ Order Response:", JSON.stringify(response, null, 2));

        if (response.success) {
            console.log("\n🎉 SUCCESS! Test bet placed successfully!");
        } else {
            console.log("\n❌ Order was not successful:", response);
        }
    } catch (e: any) {
        console.error("\n❌ Failed to place order:", e.message || e);
    }
};

runTestBet();
