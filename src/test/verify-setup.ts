import createClobClient from '../utils/createClobClient';
import getMyBalance from '../utils/getMyBalance';
import { ENV } from '../config/env';
import axios from 'axios';

/**
 * This script verifies the bot is properly configured without placing real bets.
 * It checks:
 * 1. CLOB client connection
 * 2. Wallet balance
 * 3. Market data access
 * 4. Orderbook access
 */
const verifyBotSetup = async () => {
    console.log("=".repeat(60));
    console.log("POLYMARKET COPY TRADING BOT - SETUP VERIFICATION");
    console.log("=".repeat(60));

    // 1. Check CLOB Client
    console.log("\n[1/4] Testing CLOB Client Connection...");
    try {
        const clobClient = await createClobClient();
        console.log("✅ CLOB Client initialized successfully");
    } catch (e: any) {
        console.log("❌ CLOB Client failed:", e.message);
        return;
    }

    // 2. Check Wallet Balance
    console.log("\n[2/4] Checking Wallet Balance...");
    try {
        const balance = await getMyBalance(ENV.PROXY_WALLET);
        console.log(`✅ Wallet Balance: ${balance} USDC`);

        if (balance < 1) {
            console.log("⚠️  WARNING: Balance is very low. You may not be able to place trades.");
        }
    } catch (e: any) {
        console.log("❌ Balance check failed:", e.message);
    }

    // 3. Check Market Data Access
    console.log("\n[3/4] Testing Market Data API Access...");
    try {
        const { data: markets } = await axios.get('https://gamma-api.polymarket.com/markets?active=true&limit=5');
        console.log(`✅ Market Data API accessible (${markets.length} markets found)`);
    } catch (e: any) {
        console.log("❌ Market Data API failed:", e.message);
    }

    // 4. Check Orderbook Access
    console.log("\n[4/4] Testing Orderbook Access...");
    try {
        const clobClient = await createClobClient();
        const { data: markets } = await axios.get('https://gamma-api.polymarket.com/markets?active=true&limit=10');

        let foundOrderbook = false;
        for (const market of markets) {
            let tokenIds = market.clobTokenIds;
            if (typeof tokenIds === 'string') {
                try { tokenIds = JSON.parse(tokenIds); } catch (e) { tokenIds = [tokenIds]; }
            }

            if (!tokenIds || !Array.isArray(tokenIds)) continue;

            for (const tokenID of tokenIds) {
                if (!tokenID || typeof tokenID !== 'string') continue;

                try {
                    const orderbook = await clobClient.getOrderBook(tokenID);
                    if (orderbook && orderbook.asks && orderbook.asks.length > 0) {
                        console.log(`✅ Orderbook accessible`);
                        console.log(`   Sample Market: "${market.question}"`);
                        console.log(`   Best Ask Price: ${orderbook.asks[0].price}`);
                        foundOrderbook = true;
                        break;
                    }
                } catch (e) {
                    // Skip
                }
            }
            if (foundOrderbook) break;
        }

        if (!foundOrderbook) {
            console.log("⚠️  Could not find active orderbook (markets may be inactive)");
        }
    } catch (e: any) {
        console.log("❌ Orderbook access failed:", e.message);
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("VERIFICATION COMPLETE");
    console.log("=".repeat(60));
    console.log("\n📝 NOTE: Signature validation for Gnosis Safe wallets requires");
    console.log("   the proxy wallet to be properly configured as a Safe contract.");
    console.log("   If you encounter 'invalid signature' errors, verify that:");
    console.log("   1. PROXY_WALLET is a valid Gnosis Safe address");
    console.log("   2. PRIVATE_KEY corresponds to an owner of that Safe");
    console.log("   3. The Safe has sufficient USDC balance");
    console.log("\n🚀 To start the copy trading bot, run: npm start");
    console.log("=".repeat(60));
};

verifyBotSetup();
