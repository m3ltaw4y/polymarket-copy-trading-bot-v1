import { ethers } from 'ethers';

export interface DecodedTrade {
    transactionHash: string;
    maker: string; // The user sending the trade (Target/Proxy)
    assetId: string;
    side: 'BUY' | 'SELL' | 'UNKNOWN';
    size: number; // Net Shares
    usdcSpent?: number; // For price calculation
    price?: number; // Calculated Price
    timestamp: number;
}

const ERC1155_ABI = [
    "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
    "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)"
];

const ERC20_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // Polygon USDC

export class ChainDecoder {
    private iface1155: ethers.utils.Interface;
    private iface20: ethers.utils.Interface;

    constructor() {
        this.iface1155 = new ethers.utils.Interface(ERC1155_ABI);
        this.iface20 = new ethers.utils.Interface(ERC20_ABI);
    }

    /**
     * Decodes a transaction receipt to find trade details for a specific user (EOA or Proxy).
     */
    public decodeTrade(receipt: ethers.providers.TransactionReceipt, targetAddress: string, proxyAddress: string | null): DecodedTrade | null {
        const targetLower = targetAddress.toLowerCase();
        const proxyLower = proxyAddress?.toLowerCase();

        let totalShares = ethers.BigNumber.from(0);
        let totalUsdc = ethers.BigNumber.from(0);
        let detectedSide: 'BUY' | 'SELL' | 'UNKNOWN' = 'UNKNOWN';
        let detectedAsset = '';

        for (const log of receipt.logs) {
            // Check for ERC1155 (Shares)
            try {
                const parsed = this.iface1155.parseLog(log);
                if (parsed.name === 'TransferSingle') {
                    const { from, to, id, value } = parsed.args;
                    const fromLower = from.toLowerCase();
                    const toLower = to.toLowerCase();

                    // Check Direction relative to Target/Proxy
                    if (toLower === targetLower || (proxyLower && toLower === proxyLower)) {
                        detectedSide = 'BUY'; // Target Received Shares
                        detectedAsset = id.toString();
                        totalShares = totalShares.add(value);
                    } else if (fromLower === targetLower || (proxyLower && fromLower === proxyLower)) {
                        detectedSide = 'SELL'; // Target Sent Shares
                        detectedAsset = id.toString();
                        totalShares = totalShares.add(value);
                    }
                }
            } catch (e) { /* Not an ERC1155 log */ }

            // Check for USDC Transfer (Price Calculation)
            // If BUY: Target sends USDC (from Target -> Exchange/Pool)
            // If SELL: Target gets USDC (from Exchange/Pool -> Target)
            if (log.address.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
                try {
                    const parsed = this.iface20.parseLog(log);
                    if (parsed.name === 'Transfer') {
                        const { from, to, value } = parsed.args;
                        const fromLower = from.toLowerCase();
                        const toLower = to.toLowerCase();

                        // Accumulate USDC movement involving target
                        // Note: Depending on the route (Relayer -> Proxy -> Exchange), we must track the Proxy's flow.
                        if (fromLower === targetLower || (proxyLower && fromLower === proxyLower)) {
                            // Outgoing USDC = Cost (for BUY)
                            totalUsdc = totalUsdc.add(value);
                        } else if (toLower === targetLower || (proxyLower && toLower === proxyLower)) {
                            // Incoming USDC = Payout (for SELL)
                            totalUsdc = totalUsdc.add(value);
                        }
                    }
                } catch (e) { /* Not an ERC20 log */ }
            }
        }

        if (detectedSide !== 'UNKNOWN' && totalShares.gt(0)) {
            // Format Numbers
            const size = parseFloat(ethers.utils.formatUnits(totalShares, 6)); // Shares usually 6 decimals on Polymarket? Or 18? usually matches collateral (USDC=6)
            const usdcVal = parseFloat(ethers.utils.formatUnits(totalUsdc, 6)); // USDC is 6 decimals

            let price = 0;
            if (size > 0) {
                price = usdcVal / size;
            }

            return {
                transactionHash: receipt.transactionHash,
                maker: targetAddress,
                assetId: detectedAsset,
                side: detectedSide,
                size: size,
                usdcSpent: usdcVal,
                price: price,
                timestamp: Date.now() // Approximation until block time fetched
            };
        }

        return null; // No relevant trade found
    }
}
