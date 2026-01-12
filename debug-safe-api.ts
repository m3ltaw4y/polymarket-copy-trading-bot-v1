import axios from 'axios';
import { ENV } from './src/config/env';

async function testSafeAPI() {
    const proxy = "0x1ff49fdcb6685c94059b65620f43a683be0ce7a5";
    const url = `https://safe-transaction-polygon.safe.global/api/v1/safes/${proxy}/multisig-transactions/?limit=5`;
    console.log(`Testing Safe API: ${url}`);
    try {
        const res = await axios.get(url);
        console.log(`Transactions found: ${res.data?.results?.length || 0}`);
        if (res.data?.results?.length > 0) {
            console.log("Latest Safe Tx Time:", res.data.results[0].submissionDate);
            console.log("Hash:", res.data.results[0].transactionHash);
        }
    } catch (e: any) {
        console.error(`Safe API failed: ${e.message}`);
    }
}

testSafeAPI();
