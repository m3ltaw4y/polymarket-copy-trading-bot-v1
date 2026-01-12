import { ethers } from 'ethers';
import { ENV } from '../config/env';

const RPC_URL = ENV.RPC_URL;
const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

const getMyBalance = async (address: string): Promise<number> => {
    const rpcProvider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, rpcProvider);

    const maxRetries = 3;
    const baseDelay = 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const balance_usdc = await usdcContract.balanceOf(address);
            const balance_usdc_real = ethers.utils.formatUnits(balance_usdc, 6);
            return parseFloat(balance_usdc_real);
        } catch (error: any) {
            const isLastAttempt = attempt === maxRetries;
            const status = error.status || error.response?.status || (error.error?.code === -32000 ? 502 : undefined);

            if (!isLastAttempt) {
                const delay = baseDelay * Math.pow(2, attempt);
                const errorMsg = status ? `HTTP ${status}` : (error.code || 'RPC Error');
                console.log(`[RPC RETRY] ${errorMsg} fetching balance for ${address}, retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            const finalError = status ? `HTTP ${status}` : (error.message || 'Unknown RPC error');
            throw new Error(`Failed to fetch balance after ${maxRetries} retries: ${finalError}`);
        }
    }
    return 0; // Should not reach here
};

export default getMyBalance;
