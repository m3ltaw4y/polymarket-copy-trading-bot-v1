import createClobClient from '../utils/createClobClient';
import { Side, OrderType } from '@polymarket/clob-client';
import axios from 'axios';

/**
 * Place a test bet on a specific Polymarket event
 * URL: https://polymarket.com/event/khamenei-out-as-supreme-leader-of-iran-by-january-31
 */
const placeSpecificBet = async () => {
    console.log("🎯 Placing test bet on specific market...\n");

    // Extract the slug from the URL
    const slug = "khamenei-out-as-supreme-leader-of-iran-by-january-31";

    console.log(`Fetching market data for: ${slug}`);

    try {
        // Fetch market details from Gamma API
        const { data: markets } = await axios.get(`https://gamma-api.polymarket.com/markets?slug=${slug}`);

        if (!markets || markets.length === 0) {
            console.log("❌ Market not found");
            return;
        }

        const market = markets[0];
        console.log(`\n✅ Found market: "${market.question}"`);

        // Get token IDs
        let tokenIds = market.clobTokenIds;
        if (typeof tokenIds === 'string') {
            try { tokenIds = JSON.parse(tokenIds); } catch (e) { tokenIds = [tokenIds]; }
        }

        if (!tokenIds || tokenIds.length < 2) {
            console.log("❌ Could not find token IDs");
            return;
        }

        // Token 0 is usually "Yes", Token 1 is usually "No"
        const yesTokenID = tokenIds[0];
        console.log(`Yes Token ID: ${yesTokenID}`);

        // Initialize CLOB client
        const clobClient = await createClobClient();

        // Check orderbook
        console.log("\nChecking orderbook...");
        const orderbook = await clobClient.getOrderBook(yesTokenID);

        if (!orderbook || !orderbook.asks || orderbook.asks.length === 0) {
            console.log("❌ No asks available in orderbook");
            return;
        }

        const bestAsk = orderbook.asks[0];
        const price = parseFloat(bestAsk.price);

        console.log(`Best Ask Price: ${price}`);
        console.log(`Available Size: ${bestAsk.size} shares`);

        // Place order
        const betAmount = 1.00; // $1.00 USDC

        console.log(`\n🧪 Placing BUY order...`);
        console.log(`   Amount: $${betAmount} USDC`);
        console.log(`   Side: BUY (Yes)`);
        console.log(`   Price: ${price}\n`);

        const order = await clobClient.createMarketOrder({
            tokenID: yesTokenID,
            amount: betAmount,
            side: Side.BUY,
            price: price,
        });

        const response = await clobClient.postOrder(order, OrderType.FOK);

        console.log("📋 Order Response:");
        console.log(JSON.stringify(response, null, 2));

        if (response.success) {
            console.log("\n🎉 SUCCESS! Test bet placed!");
            console.log(`You bet $${betAmount} on YES at ${price}`);
        } else if (response.error === 'invalid signature') {
            console.log("\n⚠️  Order failed: Invalid signature");
            console.log("\nThis indicates the Gnosis Safe signature validation failed.");
            console.log("Possible causes:");
            console.log("  1. The Safe hasn't approved the Polymarket CLOB contract");
            console.log("  2. The PRIVATE_KEY doesn't correspond to a Safe owner");
            console.log("  3. The Safe requires multiple signatures");
            console.log("\nTo fix this, you may need to:");
            console.log("  - Approve the CLOB contract from your Safe interface");
            console.log("  - Verify your Safe configuration on Polygon");
        } else {
            console.log(`\n❌ Order failed: ${response.error || 'Unknown error'}`);
            console.log("\nFull response:", response);
        }

    } catch (e: any) {
        console.log(`\n❌ Error: ${e.message}`);
        if (e.response) {
            console.log("API Response:", e.response.data);
        }
    }
};

placeSpecificBet();
