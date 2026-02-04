import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

async function testRPCs() {
    const rpcUrls = (process.env.RPC_URL || '').split(',');
    console.log(`🔍 Testing ${rpcUrls.length} RPC nodes...\n`);

    for (const url of rpcUrls) {
        const cleanUrl = url.trim();
        if (!cleanUrl) continue;

        process.stdout.write(`📡 Testing: ${cleanUrl} ... `);
        const provider = new ethers.providers.JsonRpcProvider(cleanUrl);
        const start = Date.now();

        try {
            const network = await Promise.race([
                provider.getNetwork(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 5s')), 5000))
            ]);
            const blockNum = await (provider as any).getBlockNumber();
            const latency = Date.now() - start;

            console.log(`✅ OK | ChainID: ${(network as any).chainId} | Block: ${blockNum} | Latency: ${latency}ms`);
        } catch (e: any) {
            console.log(`❌ FAILED | Error: ${e.message}`);
        }
    }
    console.log(`\n✨ Diagnostics Complete.`);
}

testRPCs();
